# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-03-03 | self | Initially assumed `AbortError` during voice join meant the connection was explicitly destroyed by overlapping starts. | Confirm `@discordjs/voice` error semantics in source; `entersState(..., timeout)` aborts with `AbortError` on timeout. |
| 2026-03-04 | self | Upgrading to `@discordjs/voice@0.19.0` alone did not enable DAVE in production. | Install `@snazzah/davey` explicitly in app dependencies; otherwise `max_dave_protocol_version` stays `0` and post-2026-03-02 voice joins fail. |
| 2026-03-04 | self | Left temporary high-volume diagnostics enabled after incident triage. | Gate voice handshake debug logs and dependency report behind `VOICE_DEBUG_LOGS=true`; keep default logs concise. |

## User Preferences
- Keep responses concise and practical.

## Patterns That Work
- Use `rg` for fast repo-wide searches before patching.
- For auto voice-start reliability, gate per-guild starts with a pending set and destroy stale `getVoiceConnection(guildId)` objects after failed readiness waits.
- For npm release-date checks, parse `npm view <pkg> time --json` via Node and extract specific versions to avoid massive logs.
- For recording lifecycle state, tag each recording with a unique `sessionId` and make transcript ingestion validate the active session before accepting chunks; this prevents late Deepgram events from a discarded call leaking into the next call.

## Patterns That Don't Work
- None recorded yet.

## Domain Notes
- Project: `discord-transcription`.
- User wants Anthropic model references modernized from Sonnet 3.7-era naming to `claude-sonnet-4-6`.
- Anthropic model is hardcoded in `src/transcriptManager.ts` at each `anthropic.messages.create` call; keep these in sync when changing models.
- `@anthropic-ai/sdk@0.38.0` in this repo lacks typed support for Claude 4.6 `thinking: {type: "adaptive"}` and `effort`; model string `claude-sonnet-4-6` still compiles.
- 2026-04-13: `/cancel` previously only tore down the voice connection and active-recording sets; it did not clear buffered transcript state, so cancelled-call text could be merged into the next recording. Fix was to remove `/cancel`, make `/stop_recording` discard state, and key transcript buffers by per-recording `sessionId`.
- 2026-02-19: User chose to keep current Anthropic integration as-is for now (no SDK upgrade yet). Revisit later to adopt Claude 4.6 `thinking: {type: "adaptive"}` + `effort` once SDK support is upgraded.
- 2026-02-19: Deepgram streaming model remains `nova-3` for this bot; keep README/docs aligned with runtime model setting.
- 2026-02-19: Summary prompts now include canonical-name normalization (Jan, Walter, Marcelo, Danny, Trey) and username mapping (`smalter` -> Walter, `loopboi` -> Danny), plus a one-line `Easter Egg` ending.
- 2026-02-19: Self mistake: introduced duplicate `keyterm` field while editing `src/createListeningStream.ts`; fixed immediately by removing the duplicate key.
- 2026-02-19: User wants the summary ending `Easter Egg` to sound like a personal in-house assistant rooting for the team, with motivation grounded in the specific meeting content.
- 2026-02-19: Easter Egg line must be the final line of summary output and formatted as dialogue with robot emoji + quotes: `🤖 "<one sentence>"`.
- 2026-02-19: User prefers non-corny summary endings; switched final line format to `:happysacraman: "<one sentence>"` and toned voice down to understated, concrete operator-style language.
- 2026-02-19: Reverted ending style from operator-note to classical quote line. Final line should be `:happysacraman: "<quote>" — <author>`, chosen from approved philosopher/strategist pool and tangentially related to meeting content.
- 2026-02-19: User prefers no hardcoded quotes. Prompt now provides only preferred authors (Caesar, Seneca, Nietzsche, Aristotle, Aurelius, Sun Tzu, Drucker) and asks Claude to generate a quote-like line inspired by one selected author.
- 2026-02-19: Removed `:happysacraman:` from final quote line because it did not render correctly in Discord; format is now `"<quote>" — <author>`.
- 2026-02-19: Removed re-condensing/truncation flow for summaries. New behavior: ask Claude to target ~1400 chars and split across multiple Discord messages only at section boundaries when needed.
- 2026-02-19: For split summaries, user wants original single-summary visual style preserved: title/recording/`Summary:` only once in first message, with no repeated `Summary (continued)` noise in later messages.
- 2026-02-19: Quote author selection now happens in code via random choice, then prompt pins Claude to that exact author attribution to avoid repeated Sun Tzu outputs.
- 2026-03-03: In this codebase, `entersState(connection, VoiceConnectionStatus.Ready, 20e3)` throws `AbortError: The operation was aborted` on timeout, so logs need extra state/permission context to identify root cause.
- 2026-03-03: Auto-start now preflights `ViewChannel`/`Connect` and `channel.full` before voice join to turn silent 20s timeouts into immediate actionable errors.
- 2026-03-03: Registry check: project lockfile pins `@discordjs/voice@0.18.0` (published 2024-11-17) and `discord.js@14.18.0` (published 2025-02-10), so a last-week dependency update is unlikely unless deploy pipeline ignored lockfile.
- 2026-03-03: Observed prod auto-start failure pattern: networking state `Identifying -> Closed` within ~300ms, voice status `connecting -> signalling`, then `entersState(...Ready...)` aborts at 20s while bot remains in channel. Added one-time join retry with full connection teardown.
- 2026-03-04: Manual `/join` and `/record` can reuse non-ready lingering voice connections and repeatedly timeout. Added retrying connection builder + force-destroy for stale non-ready connections in `src/interactions.ts`.
- 2026-03-04: `/record` can exceed Discord interaction window when waiting on voice readiness; always defer immediately and respond via `editReply` to avoid `DiscordAPIError[10062]: Unknown interaction`.
- 2026-03-04: Upgraded runtime voice deps to `discord.js@14.25.1` and `@discordjs/voice@0.19.0`; old versions were `14.18.0`/`0.18.0`.
- 2026-03-04: Added manual `/join` connection debug/state/error logs in `createReadyConnection` to diagnose handshake failures outside auto-start path.
- 2026-03-04: Added internal networking `close` code probes (manual + auto paths) by hooking `newState.networking.on('close', code)` in state-change logger; needed to get definitive Discord-side rejection reason.
- 2026-03-04: `@discordjs/voice@0.19.0` source dynamically imports `@snazzah/davey`, but does not ship it as a runtime dependency; this app must depend on `@snazzah/davey` directly.

## 2026-11-02 workspace correction
- Correct repository: janerikasplund/discord-transcription. Heroku app: discord-transcription-bot.
- As of 2026-11-02 Heroku main abedb4b is one commit ahead of GitHub main 0ec486c. Start changes from deployed head to preserve intentional-disconnect fix.
- OPENAI_API_KEY already set on Heroku without displaying secret. Never print .env.local or config values.
- Review findings: summary failure prevents transcript delivery; oversized summary blocks attachment; transcript state deleted before successful delivery; per-utterance signal listeners accumulate; audio before Deepgram Open is dropped; final drain uses fixed 2 seconds.
- Prior Python migration belongs to wrong repository; patch archived at /Users/jasplund/Developer/discord-transcription-python-migration.patch and tracked edits reverted there.
- Self correction: hidden tracked napkin was missed by rg --files; restored original notes and appended findings. Always check hidden instruction files explicitly.

## 2026-11-02 implementation notes
- User confirmed target model is `gpt-6.1-sol` for both summaries and titles; use OpenAI Responses with low reasoning and `store: false`. Claude integration is replaced.
- Deliver transcript attachment BEFORE requesting AI output; edit the first Discord message afterward to preserve the original summary layout. Summary/title failures must not prevent transcript delivery.
- Decode raw Discord Opus to stereo 48 kHz linear16 before sending to Deepgram. Capture synchronously without member/webhook network lookups; buffer PCM until Open and wait for CloseStream completion with bounded deadlines.
- Regression test stubs for TypeScript default imports must set `__esModule: true` when exporting `{ default: ... }`; otherwise `__importDefault` wraps the stub twice and silently hides configuration.
- Native audio regression test caught `prism-media@2.0.0-alpha.0` throwing `ERR_OUT_OF_RANGE` when checking Opus headers on valid 3-byte silence packets. Use stable `prism-media@1.3.5`; its decoder handles these packets correctly.
- 2026-11-02: Live synthetic OpenAI Responses smoke test succeeded for `gpt-6.1-sol` using the existing Heroku key (key never printed). Code remains local until explicitly deployed.
- Final local verification: `npm test` passes 16 tests (native Opus short-packet decode, pre-Open buffering, final drain, errors/deadlines, concurrent starts/stops, discard, shutdown, failed delivery retention, session isolation, Discord limits, OpenAI request schema). `npm run build:check` and `git diff --check` pass.
- Remaining operational limit: failed delivery files are local and Heroku's filesystem is ephemeral; there is no automatic durable redelivery queue. README documents this explicitly.
