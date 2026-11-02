import { Readable } from 'node:stream';
import { LiveTranscriptionEvents, ListenLiveClient, LiveTranscriptionEvent } from '@deepgram/sdk';

export interface TranscriptionHandle {
    done: Promise<void>;
    stop(): void;
    abort(): void;
}

/** Buffer PCM until Open, then wait for CloseStream's final results before resolving. */
export function streamTranscription(
    audio: Readable,
    live: ListenLiveClient,
    onTranscript: (text: string) => void,
    onAudioEnd: () => void,
    timeoutMs = 10_000,
): TranscriptionHandle {
    let resolveDone: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    let settled = false;
    let ended = false;
    let open = false;
    let closeRequested = false;
    let queuedBytes = 0;
    const queued: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const complete = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) console.error('Transcription stream failed or timed out:', error);
        queued.length = 0;
        audio.off('data', send);
        audio.off('end', end);
        live.off(LiveTranscriptionEvents.Open, opened);
        live.off(LiveTranscriptionEvents.Transcript, transcript);
        live.off(LiveTranscriptionEvents.Close, closed);
        // Retain the error handler for errors emitted during socket teardown.
        try { live.disconnect(); } catch (error) { console.error('Deepgram disconnect failed:', error); }
        if (!ended) {
            ended = true;
            onAudioEnd();
        }
        audio.destroy();
        resolveDone();
    };
    const deadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => complete(new Error('Deepgram open/final drain deadline exceeded')), timeoutMs);
    };
    const requestClose = () => {
        if (!open || !ended || closeRequested || settled) return;
        closeRequested = true;
        deadline();
        try { live.requestClose(); } catch (error) { complete(error); }
    };
    function send(data: Buffer) {
        if (settled) return;
        if (!open) {
            queuedBytes += data.length;
            // At 48kHz stereo PCM, this bounds startup buffering to about 20 seconds.
            if (queuedBytes > 4 * 1024 * 1024) {
                complete(new Error('Deepgram startup audio buffer exceeded 4 MiB'));
                return;
            }
            queued.push(data);
        } else {
            try { live.send(data); } catch (error) { complete(error); }
        }
    }
    function opened() {
        if (settled) return;
        open = true;
        clearTimeout(timer);
        for (const data of queued) {
            try { live.send(data); } catch (error) { complete(error); break; }
        }
        queued.length = 0;
        queuedBytes = 0;
        requestClose();
    }
    function end() {
        if (ended || settled) return;
        ended = true;
        onAudioEnd();
        requestClose();
    }
    function transcript(event: LiveTranscriptionEvent) {
        const text = event.channel?.alternatives?.[0]?.transcript;
        if (!settled && event.is_final && text?.trim()) onTranscript(text);
    }
    function closed() { complete(closeRequested ? undefined : new Error('Deepgram closed before audio was finalized')); }
    function failed(error: unknown) { complete(error); }
    live.on(LiveTranscriptionEvents.Open, opened);
    live.on(LiveTranscriptionEvents.Transcript, transcript);
    live.on(LiveTranscriptionEvents.Close, closed);
    live.on(LiveTranscriptionEvents.Error, failed);
    audio.on('data', send);
    audio.once('end', end);
    // Leave an error handler installed for errors emitted by pipeline teardown.
    audio.on('error', failed);
    audio.once('close', () => { if (!ended) complete(new Error('Audio closed before end')); });
    deadline();
    return {
        done,
        stop: () => { if (!ended && !settled) audio.push(null); },
        abort: () => complete(),
    };
}
