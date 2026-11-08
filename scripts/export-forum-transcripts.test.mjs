import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRecords, createApi, discoverChannels, downloadAttachment, isTranscriptAttachment,
    parseArgs, readMessages, renderBundle } from './export-forum-transcripts.mjs';

const channel = { id: '100', name: 'forum', guild_id: '200', type: 0 };
const botId = '300';
const message = (id, content, attachments = [], author = botId, seconds = Number(id)) => ({
    id: String(id), content, attachments, author: { id: author }, channel_id: channel.id,
    timestamp: new Date(Date.UTC(2026, 10, 2, 17, 0, seconds)).toISOString(),
});
const header = title => `**${title}**\n\n**Recording finished for:** jan, smalter\n\n**Summary:**\n### Overview\nMeeting summary.`;
const attachment = id => ({ id: String(id), filename: `transcript-${id}.md`, url: 'https://cdn.discordapp.com/attachments/test.md' });

test('pairs legacy split summaries and separate transcript, retaining speakers and source IDs', () => {
    const file = attachment(10);
    const messages = [message(1, '🔴 Started recording in conference room!'), message(2, header('Planning (11/02/2026)')),
        message(3, '### Decisions\nShip it.'), message(4, 'Human conversation', [], 'human'),
        message(5, '**Full Transcript:**', [file]), message(6, 'Ready!')];
    const records = collectRecords(channel, messages.reverse(), botId,
        new Map([[file.id, { text: '# Planning (11/02/2026)\n\nSpeaker @jan: Hi.\n\nSpeaker @Danny: Hello.' }]]));
    assert.equal(records.length, 1);
    assert.match(records[0].summary, /Ship it\./);
    assert.doesNotMatch(records[0].summary, /Human conversation/);
    assert.doesNotMatch(records[0].summary, /Ready!/);
    assert.deepEqual(records[0].summaryMessageIds, ['2', '3']);
    assert.deepEqual(records[0].participants, ['jan', 'smalter', 'Danny']);
    assert.equal(records[0].recordingStartNoticeId, '1');
    assert.equal(records[0].attachments[0].messageId, '5');
    assert.deepEqual(records[0].warnings, []);
});

test('supports attachment on first summary message followed by continuation', () => {
    const file = attachment(10);
    const records = collectRecords(channel, [message(2, header('Planning'), [file]), message(3, '### Decisions\nDone.')], botId,
        new Map([[file.id, { text: '# Planning\nSpeaker @jan: Hi.' }]]));
    assert.equal(records.length, 1);
    assert.match(records[0].summary, /Done\./);
    assert.equal(records[0].attachments.length, 1);
});

test('merges older repeated-title Summary (continued) messages into one recording', () => {
    const file = attachment(10);
    const continued = '**Planning**\n\n**Recording finished for:** jan, smalter\n\n**Summary (continued):**\n### Decisions & Outcomes\nApproved.';
    const records = collectRecords(channel, [message(1, header('Planning')), message(2, continued),
        message(3, '**Full Transcript:**', [file])], botId, new Map([[file.id, { text: '# Planning\nSpeaker @jan: Hi.' }]]));
    assert.equal(records.length, 1);
    assert.match(records[0].summary, /Approved\./);
    assert.deepEqual(records[0].summaryMessageIds, ['1', '2']);
    assert.deepEqual(records[0].warnings, []);
});

test('keeps surviving summary sections when initial header was deleted', () => {
    const file = attachment(10);
    const records = collectRecords(channel, [message(1, '🔴 Started recording in conference room!'),
        message(2, '### Decisions & Outcomes\nApproved.'), message(3, '**Full Transcript:**', [file])], botId,
        new Map([[file.id, { text: '# Planning\nSpeaker @jan: Hi.' }]]));
    assert.equal(records.length, 1);
    assert.equal(records[0].title, 'Planning');
    assert.equal(records[0].summary, '### Decisions & Outcomes\nApproved.');
    assert.match(records[0].warnings[0], /Summary header unavailable/);
});

test('retains reported recording duration separately from posting time', () => {
    const records = collectRecords(channel, [message(1, '🔴 Started recording in conference room!'),
        message(2, '⏹️ Recording stopped in conference room after 11m 55s\nGenerating transcript and summary... please wait.'),
        message(3, header('Planning'))], botId);
    assert.equal(records[0].recordingStopNoticeId, '2');
    assert.equal(records[0].reportedDuration, '11m 55s');
    assert.doesNotMatch(records[0].summary, /Generating transcript/);
});

test('retains summary-only recordings and does not attach a different meeting to them', () => {
    const file = attachment(10);
    const records = collectRecords(channel, [message(1, header('First')), message(2, '**Full Transcript:**', [file])], botId,
        new Map([[file.id, { text: '# Second\nSpeaker @Eric: Hi.' }]]));
    assert.equal(records.length, 2);
    assert.match(records[0].warnings[0], /no transcript attachment/);
    assert.equal(records[1].title, 'Second');
    assert.match(records[1].warnings[0], /No posted summary/);
});

test('does not pair a transcript with a stale or already completed summary', () => {
    const first = attachment(10), second = attachment(11);
    const records = collectRecords(channel, [message(1, header('First')), message(2, '', [first], botId, 1000),
        message(3, '', [second], botId, 1001)], botId, new Map([
        [first.id, { text: '# First\nTranscript' }], [second.id, { error: 'Download failed' }],
    ]));
    assert.equal(records.length, 3);
    assert.equal(records[2].attachments[0].error, 'Download failed');
});

test('new recording notices stop summary continuation matching', () => {
    const records = collectRecords(channel, [message(1, header('First')), message(2, '🔴 Started recording in conference room!'),
        message(3, 'Unrelated status')], botId);
    assert.doesNotMatch(records[0].summary, /Unrelated status/);
});

test('only selects transcript text attachments from the configured author', () => {
    assert.equal(isTranscriptAttachment(message(1, ''), { filename: 'photo.png' }), false);
    assert.equal(isTranscriptAttachment(message(1, ''), { filename: 'notes.md' }), false);
    assert.equal(isTranscriptAttachment(message(1, '**Full Transcript:**'), { filename: 'meeting.txt' }), true);
    assert.deepEqual(collectRecords(channel, [message(1, header('Other bot'), [attachment(10)], 'other')], botId), []);
});

test('message pagination continues after short pages and deduplicates overlaps', async () => {
    const routes = [];
    const pages = [[message(4, ''), message(3, '')], [message(3, ''), message(2, '')], [message(1, '')], []];
    const result = await readMessages(async route => { routes.push(route); return pages.shift(); }, '100');
    assert.deepEqual(result.map(m => m.id), ['1', '2', '3', '4']);
    assert.match(routes[1], /before=3/);
    assert.match(routes[3], /before=1/);
});

test('pagination aborts when Discord repeats a page', async () => {
    await assert.rejects(readMessages(async () => [message(1, '')], '100'), /pagination stalled/);
});

test('discovers active and multiple pages of archived forum threads', async () => {
    const routes = [];
    const thread = (id, timestamp) => ({ id, parent_id: '100', thread_metadata: { archive_timestamp: timestamp } });
    const channels = await discoverChannels(async route => {
        routes.push(route);
        if (route.includes('/active')) return { threads: [thread('3'), { id: '9', parent_id: 'other' }] };
        if (route.includes('before=')) return { threads: [thread('1', '2025-01-01T00:00:00Z')], has_more: false };
        return { threads: [thread('2', '2026-01-01T00:00:00Z')], has_more: true };
    }, { ...channel, type: 15 }, []);
    assert.deepEqual(channels.map(c => c.id), ['1', '2', '3']);
    assert.match(routes[2], /before=2026-01-01T00%3A00%3A00Z/);
});

test('private archived access failures are explicit while joined private threads are included', async () => {
    const warnings = [];
    const channels = await discoverChannels(async route => {
        if (route.includes('/active')) return { threads: [] };
        if (route.includes('/users/@me/')) return { threads: [{ id: '1' }], has_more: false };
        if (route.includes('/private')) throw new Error('Discord HTTP 403');
        return { threads: [], has_more: false };
    }, channel, warnings);
    assert.deepEqual(channels.map(c => c.id), ['1', '100']);
    assert.match(warnings[0], /private archived threads/);
});

test('API retries rate limits and transient server errors without exposing token', async () => {
    const waits = [];
    const replies = [new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 }),
        new Response('', { status: 502 }), new Response(JSON.stringify({ ok: true }), { status: 200 })];
    const api = createApi('secret', async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bot secret');
        assert.match(url, /^https:\/\/discord.com\/api\/v10\//);
        return replies.shift();
    }, async ms => waits.push(ms));
    assert.deepEqual(await api('/test'), { ok: true });
    assert.deepEqual(waits, [1000, 2000]);
    await assert.rejects(createApi('secret', async () => new Response('', { status: 403 }))('/test'),
        error => /HTTP 403/.test(error.message) && !error.message.includes('secret'));
});

test('attachment download uses no authorization and validates CDN host', async () => {
    const file = attachment(10);
    assert.deepEqual(await downloadAttachment(null, message(1, ''), file, async (url, options) => {
        assert.equal(options.headers, undefined);
        return new Response('transcript text');
    }), { text: 'transcript text' });
    assert.match((await downloadAttachment(null, message(1, ''), { ...file, url: 'https://example.com/secret' })).error, /Unexpected attachment host/);
});

test('expired attachment URLs are refreshed from their source message', async () => {
    const file = attachment(10);
    const routes = [];
    let calls = 0;
    const result = await downloadAttachment(async route => {
        routes.push(route);
        return { attachments: [{ ...file, url: file.url + '?fresh=true' }] };
    }, message(1, ''), file, async url => {
        if (++calls === 1) return new Response('', { status: 403 });
        assert.match(String(url), /fresh=true/);
        return new Response('recovered');
    });
    assert.deepEqual(result, { text: 'recovered' });
    assert.deepEqual(routes, ['/channels/100/messages/1']);
});

test('bundle includes exact text, timezone, missing-data warnings, and permanent links', () => {
    const records = collectRecords(channel, [message(1, header('Planning (11/02/2026)'))], botId);
    const bundle = renderBundle(records, { channel, timezone: 'America/New_York', exportedAt: 'now', messageCount: 1, warnings: ['Coverage warning'] });
    assert.match(bundle, /12:00:01 PM EST/);
    assert.match(bundle, /2026-11-02T17:00:01.000Z/);
    assert.match(bundle, /https:\/\/discord.com\/channels\/200\/100\/1/);
    assert.match(bundle, /no transcript attachment/);
    assert.match(bundle, /Meeting summary\./);
    assert.match(bundle, /Coverage warning/);
});

test('CLI rejects unknown options, malformed IDs, and invalid timezones', () => {
    assert.throws(() => parseArgs(['--channel-id', 'bad']), /Discord ID/);
    assert.throws(() => parseArgs(['--timezone', 'invalid']), RangeError);
    assert.throws(() => parseArgs(['--token', 'secret']), /Invalid option/);
    assert.equal(parseArgs(['--help']).help, true);
});
