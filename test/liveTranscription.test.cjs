const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LiveTranscriptionEvents: E } = require('@deepgram/sdk');
const { streamTranscription } = require('../dist/liveTranscription');
class Live extends EventEmitter {
    sent = [];
    closes = 0;
    disconnects = 0;
    send(data) { this.sent.push(data.toString()); }
    requestClose() { this.closes++; }
    disconnect() { this.disconnects++; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('buffers early audio in order, even when audio ends before Open; drains final transcript until Close', async () => {
    const audio = new PassThrough();
    const live = new Live();
    const texts = [];
    let released = 0;
    const handle = streamTranscription(audio, live, text => texts.push(text), () => released++);
    audio.write('one');
    audio.end('two');
    await tick();
    assert.equal(released, 1);
    assert.deepEqual(live.sent, []);
    assert.equal(live.closes, 0);
    live.emit(E.Open);
    assert.deepEqual(live.sent, ['one', 'two']);
    assert.equal(live.closes, 1);
    let done = false;
    handle.done.then(() => done = true);
    await tick();
    assert.equal(done, false);
    live.emit(E.Transcript, { is_final: false, channel: { alternatives: [{ transcript: 'interim' }] } });
    live.emit(E.Transcript, { is_final: true, channel: { alternatives: [{ transcript: 'final words' }] } });
    live.emit(E.Close);
    await handle.done;
    assert.deepEqual(texts, ['final words']);
    assert.equal(live.disconnects, 1);
    assert.equal(released, 1);
    assert.equal(live.listenerCount(E.Transcript), 0);
    assert.doesNotThrow(() => live.emit(E.Error, new Error('late socket error')));
});

test('Open audio forwards immediately; stop requests CloseStream once and waits', async () => {
    const audio = new PassThrough();
    const live = new Live();
    const handle = streamTranscription(audio, live, () => {}, () => {});
    live.emit(E.Open);
    audio.write('first');
    handle.stop();
    handle.stop();
    await tick();
    assert.deepEqual(live.sent, ['first']);
    assert.equal(live.closes, 1);
    live.emit(E.Close);
    await handle.done;
});

test('open timeout, drain timeout, errors and abort all settle and release resources', async () => {
    for (const action of ['open-timeout', 'drain-timeout', 'error', 'abort']) {
        const audio = new PassThrough();
        const live = new Live();
        let released = 0;
        const handle = streamTranscription(audio, live, () => {}, () => released++, 15);
        if (action === 'drain-timeout') { live.emit(E.Open); audio.end('last'); }
        if (action === 'error') live.emit(E.Error, new Error('test error'));
        if (action === 'abort') { handle.abort(); handle.abort(); }
        await handle.done;
        assert.equal(released, 1);
        assert.equal(live.disconnects, 1);
        assert.equal(audio.destroyed, true);
    }
});

test('buffer limit fails explicitly instead of retaining unbounded audio', async () => {
    const audio = new PassThrough();
    const live = new Live();
    const handle = streamTranscription(audio, live, () => {}, () => {});
    audio.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    await handle.done;
    assert.equal(live.disconnects, 1);
});
