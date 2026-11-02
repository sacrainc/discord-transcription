import { EndBehaviorType, VoiceReceiver } from '@discordjs/voice';
import { pipeline } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { createClient } from '@deepgram/sdk';
import * as prism from 'prism-media';
import { addTranscriptMessage } from './transcriptManager';
import { streamTranscription, TranscriptionHandle } from './liveTranscription';
import { ensureDirectoryExists } from './utils';
import config from './config';

const deepgram = createClient(config.deepgram_token);
ensureDirectoryExists('./recordings');

export function createListeningStream(
    recording: Set<string>,
    receiver: VoiceReceiver,
    userId: string,
    displayName: string,
    guildId: string,
    sessionId: string,
): TranscriptionHandle {
    // Subscribe synchronously: fetching members/webhooks first loses the start of speech.
    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    let decoder: prism.opus.Decoder;
    let live: ReturnType<typeof deepgram.listen.live>;
    try {
        decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        live = deepgram.listen.live({
            punctuate: true,
            interim_results: false,
            language: 'en-US',
            model: 'nova-3',
            smart_format: true,
            keyterm: ['Sacra', 'Pinegrove', 'Augment', 'Caplight', 'Forerunner', 'Decades', 'Goodfin', 'IronArc',
                'Jan', 'Walter', 'smalter', 'Marcelo', 'Danny', 'loopboi', 'Trey'],
            encoding: 'linear16',
            channels: 2,
            sample_rate: 48000,
        });
    } catch (error) {
        opusStream.destroy();
        decoder?.destroy();
        throw error;
    }
    const handle = streamTranscription(decoder, live,
        text => addTranscriptMessage(guildId, sessionId, userId, displayName, text),
        () => recording.delete(userId));
    const out = createWriteStream(`./recordings/${sessionId}-${Date.now()}-${userId}.pcm`, { mode: 0o600 });
    pipeline(opusStream, decoder, out, error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error(`Audio pipeline failed for ${displayName}:`, error);
        }
    });
    return {
        done: handle.done,
        // End the source, allowing the decoder and queued audio to flush in order.
        stop: () => { if (!opusStream.destroyed && !opusStream.readableEnded) opusStream.push(null); },
        abort: handle.abort,
    };
}
