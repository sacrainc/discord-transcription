const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { OpusEncoder } = require('@discordjs/opus');
const { LiveTranscriptionEvents: E } = require('@deepgram/sdk');
const oldCwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-audio-test-'));
process.chdir(scratch);
after(() => { process.chdir(oldCwd); fs.rmSync(scratch, { recursive: true, force: true }); });
const stub = (name, exports) => { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let schema;
class Live extends EventEmitter {
    buffers = [];
    send(buffer) { this.buffers.push(Buffer.from(buffer)); }
    requestClose() { this.emit(E.Transcript, { is_final: true, channel: { alternatives: [{ transcript: 'last words' }] } }); this.emit(E.Close); }
    disconnect() {}
}
const live = new Live();
stub('@deepgram/sdk', { ...require('@deepgram/sdk'), createClient: () => ({ listen: { live: options => { schema = options; return live; } } }) });
stub('../dist/config', { __esModule: true, default: { deepgram_token: 'test' } });
const transcripts = [];
stub('../dist/transcriptManager', { addTranscriptMessage: (...args) => transcripts.push(args) });
const { createListeningStream } = require('../dist/createListeningStream');

test('native Discord Opus packets decode to the advertised PCM format; stop flushes final words without signal listeners', async () => {
    const encoder = new OpusEncoder(48000, 2);
    const pcm = Buffer.alloc(960 * 2 * 2);
    const packet = encoder.encode(pcm);
    const audio = new Readable({ read() {} });
    const recording = new Set(['user']);
    const receiver = { subscribe: () => audio };
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    const handle = createListeningStream(recording, receiver, 'user', 'Jan', 'guild', 'session');
    audio.push(packet);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(live.buffers.length, 0);
    live.emit(E.Open);
    handle.stop();
    await handle.done;
    assert.equal(schema.encoding, 'linear16');
    assert.equal(schema.channels, 2);
    assert.equal(schema.sample_rate, 48000);
    assert.equal(Buffer.concat(live.buffers).length, pcm.length);
    assert.deepEqual(transcripts, [['guild', 'session', 'user', 'Jan', 'last words']]);
    assert.equal(recording.has('user'), false);
    assert.equal(process.listenerCount('SIGINT'), sigint);
    assert.equal(process.listenerCount('SIGTERM'), sigterm);
    // Allow the disk pipeline's close callback to finish before removing its directory.
    await new Promise(resolve => setImmediate(resolve));
});
