# Discord Transcription Bot

A Discord voice bot that transcribes conversations with Deepgram `nova-3` and generates meeting summaries and titles with OpenAI `gpt-6.1-sol`.

## Setup

1. Install Node.js 22.12 or later within Node 22, then run `npm ci`.
2. Copy `auth.sample.json` to `auth.json` and fill in your credentials, or set the environment variables below.
3. Run `npm test` to build and run the regression suite.
4. Run `npm start` to build and start the bot.
5. Type `!deploy` as the application owner to register slash commands.

The bot needs the Guilds, GuildMembers, GuildVoiceStates, GuildMessages, and MessageContent intents. Enable privileged intents in the Discord Developer Portal. It needs View Channel and Connect permissions for voice, plus View Channel, Send Messages, Attach Files, and Read Message History in the transcript channel. The legacy `!deploy` webhook setup also needs Manage Webhooks.

## Configuration

| Environment variable | Local `auth.json` field | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | `token` | Discord bot token (required) |
| `DEEPGRAM_TOKEN` | `deepgram_token` | Deepgram API key (required for transcription) |
| `OPENAI_API_KEY` | `openaiApiKey` | OpenAI API key (optional; required for summaries and titles) |
| `DEFAULT_CHANNEL` | `defaultChannel` | Transcript channel name; defaults to `transcripts` |
| `TRANSCRIPT_CHANNEL_ID` | `transcriptChannelId` | Preferred transcript destination |
| `VOICE_DEBUG_LOGS` | `voiceDebugLogs` | Set to `true` for voice handshake diagnostics |

If `auth.json` exists, it supplies configuration. `OPENAI_API_KEY` from the environment takes precedence over its local field. Claude credentials are no longer used. Keep credentials out of git.

## Recording

- `/join`: join your voice channel.
- `/record`: record everyone in your voice channel.
- `/leave`: finish recording, leave, and deliver the transcript and optional summary.
- `/stop_recording`: discard the current recording and leave without publishing it.

Automatic recording begins when at least two people are in a voice channel. Automatic recordings finish when one or fewer people remain; manual recordings finish when everyone leaves.

Audio capture subscribes immediately and decodes Discord Opus packets into stereo 48 kHz PCM. PCM is buffered while Deepgram connects (up to 4 MiB, with a 10-second connection deadline). Finishing a recording ends its audio streams and waits for Deepgram's final results and close event, with a 10-second drain deadline. Timeouts and stream errors are logged; results available before the failure are retained.

The bot saves the transcript locally and sends the full attachment before requesting AI output. It then edits that message to add the summary and title, splitting oversized text across Discord messages. Missing credentials, incomplete AI responses, and AI errors leave the transcript attachment available. Summary and title requests use the Responses API with `gpt-6.1-sol`, low reasoning effort, and `store: false`.

Transcript state is cleared after successful attachment delivery. Failed deliveries retain session state in memory and the raw transcript under `transcripts/`; the log identifies its path. There is no automatic redelivery queue. Local PCM recordings are under `recordings/`. These directories are ignored by git. On Heroku, both directories use the ephemeral dyno filesystem: files and in-memory state do not survive dyno replacement. Retrieve failed-delivery files before restarting; durable recovery across restarts would require external storage.

Shutdown stops new recordings, drains existing audio, and delivers transcripts without starting additional AI requests. A 25-second process deadline bounds shutdown; summaries already in progress may remain unfinished, with their transcript attachments already delivered.

## Heroku

The existing app is `discord-transcription-bot`, with a worker process defined in `Procfile`. Configure the variables above on that app, build the tested branch, and deploy it to the Heroku remote. Ensure the worker is running:

```bash
heroku ps:scale worker=1 --app discord-transcription-bot
heroku logs --tail --app discord-transcription-bot
```

Do not recreate the existing app. The runtime includes `@snazzah/davey` for Discord DAVE encryption; removing it breaks voice connections.

## Verification

`npm test` compiles TypeScript and runs Node's test runner. Tests cover native Opus decoding, audio arriving before Deepgram Open, final transcript drain, timeouts, buffer limits, cancellation, concurrent stops, shutdown, session isolation, Discord message limits, delivery failures, and the OpenAI request contract. External services are mocked; native audio decoding uses the installed Opus dependency.

`npm run build:check` checks TypeScript without emitting build output.
