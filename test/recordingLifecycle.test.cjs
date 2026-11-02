const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Collection } = require('discord.js');
const { VoiceConnectionStatus: Status } = require('@discordjs/voice');
const stub = (name, exports) => {
    const id = require.resolve(name);
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../dist/config', { __esModule: true, default: {} });
const events = [];
const streams = [];
let deliverySucceeds = true;
stub('../dist/createListeningStream', {
    createListeningStream(recording, receiver, userId, displayName, guildId, sessionId) {
        let resolve;
        const done = new Promise(r => resolve = r);
        const stream = {
            done,
            stop() { events.push(['stop-audio', sessionId]); recording.delete(userId); },
            abort() { events.push(['abort', sessionId]); recording.delete(userId); resolve(); },
            resolve,
        };
        streams.push(stream);
        events.push(['capture', sessionId, displayName]);
        return stream;
    },
});
stub('../dist/transcriptManager', {
    startTranscriptSession: (g, s) => events.push(['start', s]),
    sealTranscriptSession: (g, s) => events.push(['seal', s]),
    discardTranscriptSession: (g, s) => events.push(['discard', s]),
    generateTranscript: async (g, s) => { events.push(['generate', s]); return 'transcript'; },
    saveTranscript: (g, s) => { events.push(['save', s]); return '/test/transcript.md'; },
    generateSummary: async () => { events.push(['summary']); return null; },
    generateTitle: async () => { throw new Error('title should not be called without summary'); },
    sendTranscriptAndSummary: async (client, guild, transcript, summary, title, users, session, enrich) => {
        events.push(['deliver', session]);
        await enrich();
        return deliverySucceeds;
    },
});
stub('../dist/utils', { getTranscriptChannel: async () => ({ send: async () => ({ id: 'notification' }) }) });
const m = require('../dist/voiceStateManager');
class Connection extends EventEmitter {
    state = { status: Status.Ready };
    receiver = { speaking: new EventEmitter() };
    destroy() {
        this.state.status = Status.Destroyed;
        events.push(['destroy']);
    }
}
const members = new Collection([['user', { id: 'user', displayName: 'Jan' }]]);
const client = { guilds: { cache: new Collection([['guild', { members: { cache: members } }]]) } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function start() {
    const connection = new Connection();
    await m.startManualRecording('guild', 'channel', 'Voice', members, connection, client);
    return connection;
}

test('capture starts synchronously without member fetch/webhooks; concurrent stops drain once before sealing and delivery', async () => {
    const connection = await start();
    const session = m.getActiveRecordings().get('guild').sessionId;
    connection.receiver.speaking.emit('start', 'user');
    connection.receiver.speaking.emit('start', 'user');
    assert.equal(streams.length, 1);
    assert.deepEqual(events.find(e => e[0] === 'capture'), ['capture', session, 'Jan']);
    const stop = m.stopRecording('guild', client);
    const stopAgain = m.stopRecording('guild', client);
    await tick();
    assert.equal(events.filter(e => e[0] === 'stop-audio').length, 1);
    assert.equal(events.some(e => e[0] === 'seal'), false);
    assert.equal(connection.state.status, Status.Ready);
    assert.equal(connection.receiver.speaking.listenerCount('start'), 0);
    assert.equal(await m.discardRecording('guild'), false);
    streams[0].resolve();
    await Promise.all([stop, stopAgain]);
    assert.equal(connection.state.status, Status.Destroyed);
    assert.equal(m.isRecording('guild'), false);
    assert.equal(events.filter(e => e[0] === 'generate').length, 1);
    assert.ok(events.findIndex(e => e[0] === 'save') < events.findIndex(e => e[0] === 'deliver'));
    assert.ok(events.findIndex(e => e[0] === 'deliver') < events.findIndex(e => e[0] === 'summary'));
    assert.equal(events.filter(e => e[0] === 'discard').length, 1);
});

test('discard aborts outstanding streams, removes speaking listeners and never delivers', async () => {
    events.length = 0;
    const connection = await start();
    connection.receiver.speaking.emit('start', 'user');
    assert.equal(await m.discardRecording('guild'), true);
    assert.equal(m.isRecording('guild'), false);
    assert.equal(connection.receiver.speaking.listenerCount('start'), 0);
    assert.equal(connection.state.status, Status.Destroyed);
    assert.equal(events.filter(e => e[0] === 'abort').length, 1);
    assert.equal(events.some(e => e[0] === 'deliver'), false);
});

test('concurrent manual starts create one session and one speaking listener', async () => {
    events.length = 0;
    const connection = new Connection();
    const args = ['guild', 'channel', 'Voice', members, connection, client];
    const outcomes = await Promise.all([m.startManualRecording(...args), m.startManualRecording(...args)]);
    assert.deepEqual(outcomes, [true, false]);
    assert.equal(events.filter(e => e[0] === 'start').length, 1);
    assert.equal(connection.receiver.speaking.listenerCount('start'), 1);
    await m.discardRecording('guild');
});

test('failed attachment delivery retains transcript session instead of discarding it', async () => {
    events.length = 0;
    deliverySucceeds = false;
    await start();
    await m.stopRecording('guild', client);
    assert.equal(events.filter(e => e[0] === 'save').length, 1);
    assert.equal(events.filter(e => e[0] === 'deliver').length, 1);
    assert.equal(events.some(e => e[0] === 'discard'), false);
    deliverySucceeds = true;
});

test('shutdown waits for audio, delivers transcript without AI requests, and rejects new recording starts', async () => {
    events.length = 0;
    const connection = await start();
    connection.receiver.speaking.emit('start', 'user');
    const shutdown = m.shutdownRecordings(client);
    await tick();
    assert.equal(events.some(e => e[0] === 'deliver'), false);
    streams.at(-1).resolve();
    await shutdown;
    assert.equal(events.filter(e => e[0] === 'deliver').length, 1);
    assert.equal(events.some(e => e[0] === 'summary'), false);
    assert.equal(await m.startManualRecording('guild', 'channel', 'Voice', members, new Connection(), client), false);
});
