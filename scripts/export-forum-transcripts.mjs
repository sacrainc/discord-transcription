#!/usr/bin/env node
// Read-only Discord archive export. Requires Node 18+; no npm dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://discord.com/api/v10';
const compareIds = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
const link = (guild, channel, message) => `https://discord.com/channels/${guild}/${channel}/${message}`;

export function parseArgs(args) {
    const options = { timezone: 'UTC' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help') { options.help = true; continue; }
        const key = { '--channel-id': 'channelId', '--bot-id': 'botId', '--output': 'output',
            '--timezone': 'timezone', '--heroku-app': 'herokuApp', '--auth-file': 'authFile' }[args[i]];
        if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid option: ${args[i]}`);
        options[key] = args[++i];
    }
    new Intl.DateTimeFormat('en-US', { timeZone: options.timezone });
    for (const key of ['channelId', 'botId']) {
        if (options[key] && !/^\d+$/.test(options[key])) throw new Error(`${key} must be a Discord ID`);
    }
    return options;
}

export function createApi(token, fetchImpl = fetch, wait = sleep) {
    return async function api(route) {
        for (let attempt = 0; attempt < 8; attempt++) {
            let response;
            try {
                response = await fetchImpl(`${API}${route}`, {
                    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordTranscriptExport (one-off, 1.0)' },
                    signal: AbortSignal.timeout(60000),
                });
            } catch {
                if (attempt === 7) throw new Error(`Network failure reading ${route}`);
                await wait(1000 * (attempt + 1));
                continue;
            }
            if (response.status === 429) {
                const body = await response.json();
                await wait(Math.max(1000, Number(body.retry_after || 1) * 1000));
                continue;
            }
            if (response.status >= 500) { await wait(1000 * (attempt + 1)); continue; }
            if (!response.ok) throw new Error(`Discord HTTP ${response.status} reading ${route}; check bot access and Read Message History permissions`);
            return response.json();
        }
        throw new Error(`Discord retry limit reached reading ${route}`);
    };
}

export async function readMessages(api, channelId) {
    const messages = new Map();
    let before;
    while (true) {
        const page = await api(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
        if (!page.length) break;
        for (const message of page) messages.set(message.id, message);
        const next = [...page].sort(compareIds)[0].id;
        if (before && BigInt(next) >= BigInt(before)) throw new Error(`Message pagination stalled in ${channelId}`);
        before = next;
    }
    return [...messages.values()].sort(compareIds);
}

export async function discoverChannels(api, channel, warnings) {
    const channels = new Map();
    // 15/16 are forum/media containers; messages live in their threads.
    if (![15, 16].includes(channel.type)) channels.set(channel.id, channel);
    if (![0, 5, 15, 16].includes(channel.type)) return [...channels.values()];
    const active = await api(`/guilds/${channel.guild_id}/threads/active`);
    for (const thread of active.threads) if (thread.parent_id === channel.id) channels.set(thread.id, thread);
    async function archived(route, idCursor = false, optional = false) {
        let before;
        while (true) {
            let page;
            try {
                page = await api(`${route}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
            } catch (error) {
                if (!optional || !/HTTP 403/.test(error.message)) throw error;
                warnings.push('Cannot enumerate all private archived threads (Manage Threads permission missing). Joined private threads were checked separately.');
                return;
            }
            for (const thread of page.threads) channels.set(thread.id, thread);
            if (!page.has_more) return;
            const last = page.threads.at(-1);
            const next = idCursor ? last?.id : last?.thread_metadata?.archive_timestamp;
            if (!next || next === before) throw new Error(`Thread pagination stalled for ${route}`);
            before = next;
        }
    }
    await archived(`/channels/${channel.id}/threads/archived/public`);
    if (channel.type === 0) {
        await archived(`/channels/${channel.id}/users/@me/threads/archived/private`, true);
        await archived(`/channels/${channel.id}/threads/archived/private`, false, true);
    }
    return [...channels.values()].sort(compareIds);
}

export function isTranscriptAttachment(message, attachment) {
    return /\.(md|txt)$/i.test(attachment.filename || '') &&
        (/transcript/i.test(attachment.filename) || /full\s+transcript/i.test(message.content || ''));
}

export function parseHeader(content) {
    const participants = content.match(/\*\*Recording finished for:\*\*\s*([^\n]*)/i);
    const summary = content.match(/\*\*Summary(?:\s+\(continued\))?:\*\*\s*\n?/i);
    if (!participants && !summary) return null;
    return {
        title: content.match(/^\*\*([^\n]+?)\*\*\s*\n/)?.[1] || null,
        participants: participants ? participants[1].split(',').map(s => s.trim()).filter(Boolean) : [],
        summary: summary ? content.slice(summary.index + summary[0].length).trim() : '',
        continued: /\*\*Summary\s+\(continued\):\*\*/i.test(content),
    };
}

function newRecord(channel, message, header, started, stopped) {
    return {
        channelId: channel.id, channelName: channel.name, messageId: message.id,
        postedAt: message.timestamp, editedAt: message.edited_timestamp || null,
        recordingStartNoticeAt: started?.timestamp || null,
        recordingStartNoticeId: started?.id || null,
        recordingStopNoticeAt: stopped?.timestamp || null,
        recordingStopNoticeId: stopped?.id || null,
        reportedDuration: stopped?.content?.match(/after ([^\n]+)/)?.[1] || null,
        title: header?.title || null, participants: header?.participants || [],
        summary: header?.summary || '', summaryMessageIds: header ? [message.id] : [],
        attachments: [], warnings: [],
    };
}

export function collectRecords(channel, messages, botId, downloads = new Map()) {
    const records = [];
    let current;
    let started;
    let stopped;
    for (const message of [...messages].sort(compareIds)) {
        if (message.author?.id !== botId) continue;
        const content = message.content || '';
        if (/started recording/i.test(content) && !parseHeader(content)) {
            started = message;
            stopped = undefined;
            current = undefined;
            continue;
        }
        if (/^⏹️?\s*Recording stopped/i.test(content)) {
            stopped = message;
            current = undefined;
            continue;
        }
        const header = parseHeader(content);
        if (header) {
            const age = current ? Math.abs(Date.parse(message.timestamp) - Date.parse(current.postedAt)) : Infinity;
            if (header.continued && current && age <= 15 * 60 * 1000 && header.title === current.title) {
                current.summary += `${current.summary ? '\n\n' : ''}${header.summary}`;
                current.summaryMessageIds.push(message.id);
                current.participants = [...new Set([...current.participants, ...header.participants])];
            } else {
                current = newRecord(channel, message, header, started, stopped);
                if (header.continued) current.warnings.push('Initial summary message unavailable; this summary starts with a continuation.');
                records.push(current);
                started = stopped = undefined;
            }
        } else if (!current && /^###\s+(?:High-Level Overview|Key Discussion Points|Decisions & Outcomes)/i.test(content)) {
            // Some historical first summary messages were deleted while later sections survived.
            current = newRecord(channel, message, { summary: content.trim() }, started, stopped);
            current.warnings.push('Summary header unavailable; only surviving summary sections were found.');
            records.push(current);
            started = stopped = undefined;
        }
        const attachments = (message.attachments || []).filter(a => isTranscriptAttachment(message, a));
        for (const attachment of attachments) {
            const downloaded = downloads.get(attachment.id);
            const text = downloaded?.text ?? '';
            const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
            // Pair legacy separate attachment posts only with a nearby matching summary.
            // Newer bot versions attach the file to the summary itself.
            const age = current ? Math.abs(Date.parse(message.timestamp) - Date.parse(current.postedAt)) : Infinity;
            if (!current || (message.id !== current.messageId &&
                (current.attachments.length || age > 15 * 60 * 1000 || (title && current.title && title !== current.title)))) {
                current = newRecord(channel, message, null, started, stopped);
                records.push(current);
                started = stopped = undefined;
            }
            current.title ||= title;
            current.attachments.push({ id: attachment.id, filename: attachment.filename,
                messageId: message.id, postedAt: message.timestamp, text,
                error: downloaded?.error || (!text ? 'Attachment was empty or not downloaded' : null) });
            for (const match of text.matchAll(/^Speaker\s+@(.+?):/gm)) {
                if (!current.participants.includes(match[1])) current.participants.push(match[1]);
            }
        }
        if (!header && !attachments.length && current && message.id !== current.messageId && content.trim()) {
            const age = Math.abs(Date.parse(message.timestamp) - Date.parse(current.postedAt));
            if (age <= 15 * 60 * 1000 && /^(?:#{1,6}\s|[-*]\s|["“])/.test(content.trim())) {
                current.summary += `${current.summary ? '\n\n' : ''}${content.trim()}`;
                current.summaryMessageIds.push(message.id);
            }
        }
    }
    for (const record of records) {
        if (!record.attachments.length) record.warnings.push('Summary found, but no transcript attachment was matched.');
        if (!record.summary) record.warnings.push('No posted summary was matched.');
        for (const attachment of record.attachments) if (attachment.error) record.warnings.push(`${attachment.filename}: ${attachment.error}`);
    }
    return records;
}

export async function downloadAttachment(api, message, attachment, fetchImpl = fetch) {
    let current = attachment;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const url = new URL(current.url);
            if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
                return { error: 'Unexpected attachment host; download skipped' };
            }
            // Never send bot credentials to the attachment CDN.
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
            if (response.ok) return { text: await response.text() };
        } catch { /* Refresh signed URLs and retry transient download failures. */ }
        if (attempt < 3) {
            const fresh = await api(`/channels/${message.channel_id}/messages/${message.id}`);
            current = fresh.attachments.find(a => a.id === attachment.id);
            if (!current) return { error: 'Attachment no longer exists on the source message' };
            await sleep(1000 * (attempt + 1));
        }
    }
    return { error: 'Download failed after retries and URL refresh' };
}

export function renderBundle(records, manifest) {
    const formatTime = value => value ? new Intl.DateTimeFormat('en-US', {
        timeZone: manifest.timezone, dateStyle: 'full', timeStyle: 'long',
    }).format(new Date(value)) : 'Unknown';
    const lines = ['DISCORD TRANSCRIPT BUNDLE', `Channel: #${manifest.channel.name} (${manifest.channel.id})`,
        `Exported: ${manifest.exportedAt}`, `Display timezone: ${manifest.timezone}`,
        `Recordings: ${records.length}`, `Messages scanned: ${manifest.messageCount}`,
        'Dates/times below are Discord posting times, not exact meeting start/end times.',
        'Participants preserve posted names and transcript speaker labels; names are not normalized.',
        'Coverage: messages still available to this bot at export time; deleted/inaccessible history cannot be recovered.',
        '', 'EXPORT WARNINGS', ...(manifest.warnings.length ? manifest.warnings.map(w => `- ${w}`) : ['None']), '', 'INDEX'];
    records.forEach((r, i) => lines.push(`${i + 1}. ${r.postedAt} | ${r.title || '(Untitled recording)'} | ${r.participants.join(', ') || 'Unknown participants'}`));
    records.forEach((r, i) => {
        lines.push('', '='.repeat(80), `RECORDING ${i + 1}: ${r.title || '(Untitled recording)'}`, '='.repeat(80),
            `Posted date/time: ${formatTime(r.postedAt)}`, `Posted date/time (UTC): ${new Date(r.postedAt).toISOString()}`,
            `Date in original title: ${r.title?.match(/\((\d{1,2}\/\d{1,2}\/\d{4})\)/)?.[1] || 'Not specified'}`,
            `Recording start notice: ${formatTime(r.recordingStartNoticeAt)} (if available; not a verified start time)`,
            `Recording stop notice: ${formatTime(r.recordingStopNoticeAt)}`,
            `Reported duration: ${r.reportedDuration || 'Not available'}`,
            `Participants: ${r.participants.join(', ') || 'Not available'}`, `Channel/thread: #${r.channelName}`,
            `Source: ${link(manifest.channel.guild_id, r.channelId, r.messageId)}`);
        if (r.editedAt) lines.push(`Summary edited at: ${r.editedAt}`);
        for (const id of r.summaryMessageIds) lines.push(`Summary source: ${link(manifest.channel.guild_id, r.channelId, id)}`);
        for (const warning of r.warnings) lines.push(`WARNING: ${warning}`);
        lines.push('', 'SUMMARY', '', r.summary || '[No summary available]', '', 'FULL TRANSCRIPT');
        if (!r.attachments.length) lines.push('', '[No transcript attachment found]');
        for (const a of r.attachments) lines.push('', `Attachment: ${a.filename}`, `Attachment posted: ${a.postedAt}`,
            `Attachment source: ${link(manifest.channel.guild_id, r.channelId, a.messageId)}`, '', a.text || `[Unavailable: ${a.error}]`);
    });
    return `${lines.join('\n')}\n`;
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (options.help) {
        console.log(`Usage: node scripts/export-forum-transcripts.mjs [options]
  --channel-id ID    Channel to export (defaults to configured transcript channel)
  --bot-id ID        Original posting bot, if different from the authenticated bot
  --output DIR       New output directory (must not already contain an export)
  --timezone ZONE    Display timezone (default UTC; e.g. America/New_York)
  --auth-file PATH   Read token/transcriptChannelId from auth.json
  --heroku-app APP   Read existing bot credentials via Heroku CLI (no deployment)
Uses DISCORD_TOKEN and TRANSCRIPT_CHANNEL_ID, or auth.json. Only makes GET requests.`);
        return;
    }
    let config = {};
    if (options.herokuApp) {
        try {
            config = JSON.parse(execFileSync('heroku', ['config', '--json', '--app', options.herokuApp],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        } catch { throw new Error('Unable to read Heroku configuration; check CLI login and app access'); }
    } else {
        try { config = JSON.parse(await readFile(options.authFile || 'auth.json', 'utf8')); }
        catch (error) { if (options.authFile || error.code !== 'ENOENT') throw new Error('Unable to read auth.json configuration'); }
    }
    const token = process.env.DISCORD_TOKEN || config.DISCORD_TOKEN || config.token;
    const channelId = options.channelId || process.env.TRANSCRIPT_CHANNEL_ID || config.TRANSCRIPT_CHANNEL_ID || config.transcriptChannelId;
    if (!token || !channelId) throw new Error('DISCORD_TOKEN and a channel ID are required; see --help');
    if (!/^\d+$/.test(channelId)) throw new Error('Channel ID must be a Discord ID');
    const api = createApi(token);
    const [me, channel] = await Promise.all([api('/users/@me'), api(`/channels/${channelId}`)]);
    if (!channel.guild_id || ![0, 5, 10, 11, 12, 15, 16].includes(channel.type)) throw new Error('Choose a guild text/forum channel or thread');
    const output = resolve(options.output || join('exports', `forum-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    await mkdir(resolve(output, '..'), { recursive: true });
    // An exclusive directory prevents accidentally overwriting an earlier archive.
    await mkdir(output, { mode: 0o700 });
    const warnings = [];
    const channels = await discoverChannels(api, channel, warnings);
    const botId = options.botId || me.id;
    const records = [];
    const rawChannels = [];
    let messageCount = 0;
    for (const source of channels) {
        console.log(`Reading #${source.name} (${source.id})...`);
        const messages = await readMessages(api, source.id);
        messageCount += messages.length;
        console.log(`  Scanned ${messages.length} messages; downloading transcript attachments...`);
        // Preserve the source messages locally so ambiguous matches can be reviewed.
        rawChannels.push({ channel: source, messages: messages.filter(m => m.author?.id === botId) });
        await writeFile(join(output, 'source-messages.json'), JSON.stringify(rawChannels, null, 2), { mode: 0o600 });
        const downloads = new Map();
        for (const message of messages) {
            if (message.author?.id !== botId) continue;
            for (const attachment of message.attachments || []) {
                if (!isTranscriptAttachment(message, attachment)) continue;
                try { downloads.set(attachment.id, await downloadAttachment(api, message, attachment)); }
                catch { downloads.set(attachment.id, { error: 'Unable to refresh/download attachment' }); }
                if (downloads.size % 25 === 0) console.log(`  Downloaded ${downloads.size} transcript attachment(s)...`);
            }
        }
        records.push(...collectRecords(source, messages, botId, downloads));
        console.log(`  ${messages.length} messages; ${downloads.size} transcript attachment(s)`);
        // Save progress after each channel in case a later channel becomes inaccessible.
        await writeFile(join(output, 'source-messages.json'), JSON.stringify(rawChannels, null, 2), { mode: 0o600 });
    }
    records.sort((a, b) => compareIds({ id: a.messageId }, { id: b.messageId }));
    const flagged = records.filter(r => r.warnings.length);
    if (!records.length) warnings.push('No transcripts or summary headers found. Check channel, posting bot ID, and message visibility.');
    if (flagged.length) warnings.push(`${flagged.length} recording(s) have missing or partial summary/transcript data; see individual warnings.`);
    const failed = records.flatMap(r => r.attachments).filter(a => a.error).length;
    if (failed) warnings.push(`${failed} transcript attachment download(s) failed.`);
    const manifest = { exportedAt: new Date().toISOString(), channel, botId, timezone: options.timezone,
        messageCount, channelsScanned: channels.map(c => ({ id: c.id, name: c.name })),
        recordingCount: records.length, attachmentCount: records.reduce((n, r) => n + r.attachments.length, 0),
        summaryOnlyCount: records.filter(r => !r.attachments.length).length,
        missingSummaryCount: records.filter(r => !r.summary).length,
        partialSummaryCount: records.filter(r => r.warnings.some(w => /Summary header|Initial summary/.test(w))).length,
        failedDownloads: failed, warnings };
    await writeFile(join(output, 'transcript-bundle.txt'), renderBundle(records, manifest), { mode: 0o600 });
    await writeFile(join(output, 'recordings.json'), JSON.stringify(records, null, 2), { mode: 0o600 });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(`Exported ${records.length} recording(s) to ${output}`);
    for (const warning of warnings) console.warn(`WARNING: ${warning}`);
    if (failed || !records.length) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`Export failed: ${error.message}`); process.exitCode = 1; });
}
