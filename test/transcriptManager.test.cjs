const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const originalCwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-transcript-test-'));
process.chdir(scratch);
after(() => { process.chdir(originalCwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const configPath = require.resolve('../dist/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { __esModule: true, default: { openaiApiKey: 'test-key' } } };
let response = { status: 'completed', output_text: 'summary text' };
let request;
const openaiPath = require.resolve('openai');
require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: class OpenAI {
    responses = { create: async body => { request = body; return response; } };
} };
const utils = require('../dist/utils');
let channel;
utils.getTranscriptChannel = async () => channel;
const m = require('../dist/transcriptManager');

test('uses exact OpenAI model and Responses schema; rejects incomplete output', async () => {
    assert.equal(await m.generateSummary('meeting'), 'summary text');
    assert.equal(request.model, 'gpt-6.1-sol');
    assert.equal(request.input, 'meeting');
    assert.equal(request.store, false);
    assert.deepEqual(request.reasoning, { effort: 'low' });
    await m.generateTitle('summary');
    assert.equal(request.model, 'gpt-6.1-sol');
    response = { status: 'incomplete', output_text: 'partial summary' };
    assert.equal(await m.generateSummary('meeting'), null);
    response = { status: 'completed', output_text: '' };
    assert.match(await m.generateTitle('summary'), /Meeting Transcript/);
});

test('overlapping sessions remain isolated while the previous session drains; sealed/discarded chunks are ignored', async () => {
    m.startTranscriptSession('guild', 'old');
    m.addTranscriptMessage('guild', 'old', 'a', 'Jan', 'WAP swapped');
    m.startTranscriptSession('guild', 'new');
    m.addTranscriptMessage('guild', 'old', 'a', 'Jan', 'last words');
    m.addTranscriptMessage('guild', 'new', 'b', 'Walter', 'new meeting');
    assert.equal(await m.generateTranscript('wrong-guild', 'old', {}), null);
    m.discardTranscriptSession('wrong-guild', 'old');
    m.sealTranscriptSession('guild', 'old');
    m.addTranscriptMessage('guild', 'old', 'a', 'Jan', 'must ignore');
    assert.equal(await m.generateTranscript('guild', 'old', {}), 'Speaker @Jan: Whop swapped last words');
    assert.equal(await m.generateTranscript('guild', 'old', {}), 'Speaker @Jan: Whop swapped last words');
    m.discardTranscriptSession('guild', 'old');
    m.addTranscriptMessage('guild', 'old', 'a', 'Jan', 'late');
    assert.equal(await m.generateTranscript('guild', 'old', {}), null);
    assert.equal(await m.generateTranscript('guild', 'new', {}), 'Speaker @Walter: new meeting');
    m.discardTranscriptSession('guild', 'new');
});

test('all messages fit Discord, including long headers, unbroken sections and emoji', () => {
    for (const summary of ['short', '### Topic\n' + 'word '.repeat(2000), 'x'.repeat(8000), '🤖'.repeat(3000), '### One\ntext\n### Two\n' + 'more '.repeat(500)]) {
        for (const users of [['Jan'], ['user'.repeat(1000)]]) {
            const parts = m.chunkSectionsForDiscord('Meeting', users, summary);
            assert.ok(parts.length > 0);
            assert.ok(parts.every(part => part.length <= 1950 && part.length > 0));
            assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
            assert.equal(parts.join('\n').match(/\*\*Summary:\*\*/g).length, 1);
        }
    }
});

test('saves before network failure; retries retained data and attaches transcript with first message', async () => {
    channel = { send: async () => { throw new Error('Discord down'); } };
    assert.equal(await m.sendTranscriptAndSummary({}, 'g', 'raw text', null, 'Title', ['Jan'], 'failed'), false);
    const filepath = path.join(scratch, 'transcripts', 'transcript-g-failed.md');
    assert.equal(fs.readFileSync(filepath, 'utf8'), 'raw text');
    const sent = [];
    channel = { send: async msg => { sent.push(msg); return { edit: async () => {} }; } };
    assert.equal(await m.sendTranscriptAndSummary({}, 'g', 'raw text', null, 'Title', ['Jan'], 'failed'), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].files[0].attachment.toString(), '# Title\n\nraw text');
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('attachment is sent before enrichment; summary failure cannot undo delivery', async () => {
    let attached = false;
    channel = { send: async msg => { attached = !!msg.files; return { edit: async () => {} }; } };
    const result = await m.sendTranscriptAndSummary({}, 'g', 'raw', null, 'Title', ['Jan'], 'ai-fail', async () => {
        assert.equal(attached, true);
        throw new Error('AI unavailable');
    });
    assert.equal(result, true);
});

test('enrichment edits first message once, splits continuations, and tolerates later Discord failure', async () => {
    const calls = [];
    channel = { send: async msg => {
        calls.push(['send', msg]);
        if (calls.length > 2) throw new Error('continuation failed');
        return { edit: async msg => { calls.push(['edit', msg]); } };
    } };
    assert.equal(await m.sendTranscriptAndSummary({}, 'g', 'raw', null, 'Title', ['Jan'], 'enriched', async () => ({
        summary: '### Long\n' + 'word '.repeat(1500), title: 'New title',
    })), true);
    assert.equal(calls[0][0], 'send');
    assert.equal(calls[1][0], 'edit');
    assert.ok(calls.every(([,msg]) => msg.content.length <= 1950));
    assert.equal(calls[0][1].files.length, 1);
});
