# Live Assistant

Live Assistant is a local-first foundation for turning livestream events into useful, bounded, streamer-facing information. Simulator mode runs entirely offline, and an optional TikFinity adapter can receive local TikTok LIVE events:

```text
SimulatorConnector -> canonical LiveEvent -> bounded LiveEventBus
                                         |-> bounded EventHistory
                                         `-> AttentionEngine -> AttentionDecision
                                                              `-> SpeechCandidate
                                                                   `-> final speech policy
                                                                        `-> bounded SpeechQueue
                                                                             `-> SpeechWorker
                                                                                  `-> optional Windows system TTS

TikFinity Desktop -> TikFinityConnector -> TikFinityNormalizer
                                       -> the same LiveEventBus and consumers

Dedicated Chrome -> local CDP -> TikTokBrowserConnector -> Webcast decoder
                                                        -> TikTokBrowserNormalizer
                                                        -> the same LiveEventBus and consumers

TikFinity / TikTok Browser / Simulator -> LiveAssistantRuntime -> local control server
                                                              |-> REST + SSE
                                                              `-> browser dashboard
```

## Requirements

- Node.js 22 or newer

The only runtime package dependency is `protobufjs`, used by the local TikTok Webcast decoder. Simulator and TikFinity passthrough/deterministic operation requires no AI provider. AI Attention is an explicit opt-in that sends selected chat text to OpenAI and requires `OPENAI_API_KEY`.

Local audio playback currently requires Windows PowerShell and an installed `System.Speech` voice. Speech remains off by default.

## Run it

```sh
npm run demo
npm test
npm run validate
```

Available simulator scenarios include `quiet-chat`, `mixed-burst`, `malformed-input`, `attention-question-burst`, `attention-busy-chat`, `attention-low-information`, `attention-mixed`, and `attention-semantic-burst`:

```sh
npm start -- malformed-input
node src/cli.js malformed-input --include-raw
node src/cli.js --scenario=attention-question-burst --attention=deterministic
node src/cli.js --scenario=attention-semantic-burst --attention=ai
```

Enable Windows system speech for the simulator:

```sh
node src/cli.js --scenario=quiet-chat --speech=windows
```

TikFinity Desktop mode uses its local WebSocket endpoint and remains optional:

```sh
node src/cli.js --connector=tikfinity
node src/cli.js --connector=tikfinity --speech=windows
```

The default endpoint is `ws://127.0.0.1:21213/`. If TikFinity is not running, Live Assistant remains alive, reports connection state, and retries with bounded exponential backoff. Press Ctrl+C to stop; explicit shutdown cancels reconnect attempts. Simulator mode remains the default.

Supported mappings are `chat` -> `chat.message`, `gift` -> `gift.received`, `share` -> `social.share`, `follow` -> `social.follow`, `like` -> `engagement.like`, `roomUser` -> `room.viewer_count`, and `subscribe` -> `subscription.started`. Unsupported and recognized-but-malformed envelopes become inspectable `platform.unknown` events. Every normalized event retains the complete `{ event, data }` envelope in `raw`.

## TikTok Browser Connector

`tiktok-browser` is a read-only, unofficial TikTok LIVE input for cases where TikFinity is unsuitable. A dedicated Chrome profile owns TikTok login, cookies, browser challenges, and the actual Webcast WebSocket. Live Assistant attaches locally through CDP, creates one page, blocks livestream media before navigation, observes binary Webcast messages, decodes selected protobuf events locally, and feeds the existing canonical pipeline. It does not use DOM scraping and never needs your TikTok password.

The Chrome remote-debugging port grants powerful browser access. Keep it loopback-only, never expose port 9222 to a LAN or the internet, and never use your normal Chrome profile. Current Chrome also requires remote debugging to use a non-default user-data directory. Start a persistent dedicated profile in PowerShell:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --user-data-dir="$env:LOCALAPPDATA\LiveAssistant\TikTokChrome"
```

If Chrome is installed under 32-bit Program Files, use `${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe` instead. Normally, start this dedicated Chrome once, log into TikTok once, and leave Chrome running. The development loop is: start Chrome once -> log in once -> repeatedly start and stop Live Assistant. Ensure the creator is currently LIVE, then run:

```powershell
node src/cli.js `
  --dashboard `
  --connector=tiktok-browser `
  --tiktok-user=<USERNAME> `
  --attention=deterministic
```

Open `http://127.0.0.1:4820/`. Add `--speech=windows` for optional local TTS; `--attention=ai` remains a separate opt-in requiring OpenAI configuration. A leading `@` in `--tiktok-user` is accepted. `LIVE_ASSISTANT_TIKTOK_BROWSER_USERNAME` can provide the username instead.

Media blocking is enabled by default. CDP Fetch interception is installed before navigation; `Media` requests and URLs classified locally as FLV, HLS/m3u8, MP4, M4S, `pull-flv`, or `pull-hls` are aborted, while every other paused request is explicitly continued. Document, script, fetch/XHR, CSS, API, and WebSocket requests are not blocked unless their URL explicitly contains one of those media markers. Live Assistant does not inspect cookies, browser storage, password data, authorization headers, or browser profile files. Status and diagnostics omit request URLs, debugger/WebSocket queries, and headers; canonical `raw` contains only the bounded decoded event, never binary frames or complete CDP messages.

Supported native mappings are:

```text
WebcastChatMessage        -> chat.message
WebcastGiftMessage        -> gift.received
WebcastLikeMessage        -> engagement.like (incremental count)
WebcastSocialMessage      -> social.follow for action 1
                          -> social.share for actions 2..5
WebcastRoomUserSeqMessage -> room.viewer_count (viewerCount, not cumulative totalUser)
WebcastSubNotifyMessage   -> subscription.started
```

`WebcastMemberMessage` is schema-supported and decoded in compatibility tests, but is suppressed at runtime because v1 has no canonical join event. Unselected protocol housekeeping is also suppressed. Malformed selected messages remain isolated and later frames continue.

The connector reports `connected` only after a matching active Webcast socket appears. Chrome may replace that socket without replacing the page; the connector accepts the replacement within a bounded stale window. Full CDP loss, target loss, initial socket timeout, or prolonged Webcast loss cleans up local state and retries with bounded exponential backoff. Shutdown closes only Live Assistant's page and CDP connection—it never closes Chrome, deletes the profile, or logs you out.

Available environment overrides are:

```text
LIVE_ASSISTANT_TIKTOK_BROWSER_USERNAME
LIVE_ASSISTANT_TIKTOK_BROWSER_CDP_URL
LIVE_ASSISTANT_TIKTOK_BROWSER_NAVIGATION_TIMEOUT_MS
LIVE_ASSISTANT_TIKTOK_BROWSER_SOCKET_TIMEOUT_MS
LIVE_ASSISTANT_TIKTOK_BROWSER_STALE_SOCKET_TIMEOUT_MS
LIVE_ASSISTANT_TIKTOK_BROWSER_MAX_QUEUED_EVENTS
LIVE_ASSISTANT_TIKTOK_BROWSER_BLOCK_MEDIA
LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_INITIAL_MS
LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_MAX_MS
LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_MULTIPLIER
LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_JITTER_RATIO
```

Only `localhost`, `127.0.0.1`, and `::1` CDP hosts are accepted. The Webcast protocol is unofficial and TikTok changes may break decoding. Real chat, like, room-user, and member frames were observed in the preflight experiment; follow, share, gift, and subscription still require manual real-LIVE validation.

Manual acceptance test: start dedicated Chrome, log in if necessary, start the creator's LIVE normally, run the command above, then send a unique comment and likes from a second account. Confirm the connector reaches `connected`, chat/likes/viewer count appear canonically, the dashboard and Attention continue operating, and the owned page does not download FLV/HLS video. Follow/share and Windows speech can then be checked optionally.

Configuration is centralized in `src/config/defaults.js`. A small set of safe tuning values can be overridden through environment variables; invalid overrides fall back to defaults with a diagnostic. TikFinity supports `LIVE_ASSISTANT_TIKFINITY_URL`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER`, and `LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO`. Set `LIVE_ASSISTANT_INSPECT_RAW=true` or pass `--include-raw` to explicitly include upstream payloads in inspector output.

Speech supports `LIVE_ASSISTANT_SPEECH_ENGINE=off|windows`, `LIVE_ASSISTANT_SPEECH_VOICE`, `LIVE_ASSISTANT_SPEECH_VOICE_EN`, `LIVE_ASSISTANT_SPEECH_VOICE_TH`, `LIVE_ASSISTANT_SPEECH_RATE` (`-10` to `10`), and `LIVE_ASSISTANT_SPEECH_VOLUME` (`0` to `100`). `--speech=off|windows` overrides the configured engine for one CLI run. A valid global voice override takes precedence. Otherwise Thai-script text prefers an installed `th-*` voice, Latin text prefers an installed `en-*` voice, and mixed/unknown text uses the configured/default English fallback. Detection is conservative Unicode script classification, not semantic language detection.

Windows multilingual TTS requires the corresponding voice to be installed and visible to `System.Speech`. If Thai text arrives without a `th-*` voice, the engine emits `speech.voice_unavailable` with `requestedLanguage: th-TH` and uses the configured/default English fallback without stopping the FIFO worker. Inspect the current `System.Speech` inventory in PowerShell without playing audio:

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() |
  ForEach-Object { $_.VoiceInfo } |
  Select-Object Name, Culture, Gender
```

The exported `discoverWindowsSystemSpeechVoices()` provider returns only `name`, `language`, optional `gender`, and `enabled`; it never returns registry paths. On the validation machine, only Microsoft David Desktop and Microsoft Zira Desktop (`en-US`) were exposed. Do not assume a Thai voice is installed after adding a Windows language pack—confirm it with the command above.

Speech requests remain FIFO. The worker waits without polling, speaks one request at a time, and isolates ordinary provider failures. A finite connector run closes the producer side and drains queued speech before exit. Ctrl+C cancels the active PowerShell child, clears remaining speech, and exits promptly.

## Deterministic Attention

Attention is an explicit boundary between canonical events and final speech filtering. The default `passthrough` mode preserves prior chat behavior. Select Phase 1 attention with `--attention=deterministic` or `LIVE_ASSISTANT_ATTENTION_MODE=deterministic`.

Deterministic mode classifies canonical events as `question`, `message`, `low_information`, or `non_chat`; maintains recent chat bounded by both time and count; derives `quiet`, `busy`, or `very_busy` traffic; and applies explainable configured scores and traffic-dependent thresholds. Questions are grouped for a fixed 1500 ms window only when their exact-normalized text matches. Normalization uses Unicode NFKC, trimming, whitespace collapse, case folding, and repeated terminal question-mark normalization. Stable user IDs (or usernames) determine the unique-viewer bonus; unknown identities never inflate that count. A finite simulator flushes pending groups before its speech queue drains.

**Deterministic Attention is not semantic AI.** For example, `What weapon are you using?` and `What sword are you using?` remain separate. There is no synonym matching, edit-distance intent guessing, LLM, embedding, or summarization model.

Attention produces inspectable `AttentionDecision` records and provider-independent `SpeechCandidate` values. The final `DeterministicSpeechPolicy` still enforces URL, length, duplicate, per-user cooldown, disabled-user, and queue-pressure controls. A promoted candidate can therefore still be rejected. The queue remains FIFO; priority is metadata in this phase. Attention continues while speech is off or paused, while candidates observed during a pause are marked ineligible and are never replayed after resume.

Attention defaults are: a 10,000 ms/500-message recent window, 1,500 ms group window, 128 pending groups, 200 decisions, bases of 45/65/10 for message/question/low-information, +10 per additional known viewer capped at 25, traffic counts of 8/20, and thresholds of 40/60/75. Supported overrides are:

```text
LIVE_ASSISTANT_ATTENTION_MODE
LIVE_ASSISTANT_ATTENTION_RECENT_WINDOW_MS
LIVE_ASSISTANT_ATTENTION_GROUP_WINDOW_MS
LIVE_ASSISTANT_ATTENTION_MAX_RECENT_MESSAGES
LIVE_ASSISTANT_ATTENTION_MAX_PENDING_GROUPS
LIVE_ASSISTANT_ATTENTION_DECISION_HISTORY_LIMIT
LIVE_ASSISTANT_ATTENTION_BUSY_MESSAGE_COUNT
LIVE_ASSISTANT_ATTENTION_VERY_BUSY_MESSAGE_COUNT
LIVE_ASSISTANT_ATTENTION_QUIET_THRESHOLD
LIVE_ASSISTANT_ATTENTION_BUSY_THRESHOLD
LIVE_ASSISTANT_ATTENTION_VERY_BUSY_THRESHOLD
```

Invalid values or invalid busy/threshold ordering produce a structured configuration diagnostic and retain safe defaults.

## AI Attention Phase 2

AI mode may group semantically equivalent viewer intents inside a bounded batch and produce a concise streamer-facing summary. It is selected explicitly with `--attention=ai` or `LIVE_ASSISTANT_ATTENTION_MODE=ai`; the default remains `passthrough`. A configured OpenAI provider uses the Responses API with strict JSON Schema output, `store: false`, no background mode, no continuation ID, and no tools. The default model is `gpt-5.6-luna` with low reasoning effort and low verbosity.

```powershell
$env:OPENAI_API_KEY = "your-key"
node src/cli.js --dashboard --scenario=attention-semantic-burst --attention=ai
```

AI mode sends only a local item ID, normalized chat text, occurrence count, known unique-viewer count, and deterministic classification hint. It does not send canonical source IDs, user IDs, usernames, display names, avatar URLs, connector metadata, or `LiveEvent.raw`. Viewer messages are serialized as user-data input beneath fixed source-controlled instructions. The API key is used only in the Authorization header and is never stored in application config, status, diagnostics, SSE, or browser state.

The batcher pre-compresses exact-normalized duplicates and returns immediately from event ingestion. Defaults are a 1,000 ms window, 20 source messages, 20 items, 6,000 characters, three waiting batches, one concurrent request, 160 summary characters, 30 requests/minute, a 6,000 ms request timeout, three failures before circuit-open, and a 30,000 ms circuit cooldown. There are no automatic retries. Timeout, HTTP/network failure, refusal, malformed or incomplete item mapping, response overflow, local budget exhaustion, pending overflow, and circuit-open state use visible `deterministic_fallback` decisions.

The model supplies grouping, classification, importance, a stable reason category, and a summary. The application validates complete one-time item coverage, calculates event/viewer counts locally, applies the existing quiet/busy/very-busy threshold, formats reliable viewer counts locally, and then sends promoted candidates through the unchanged final speech policy. Model importance is not confidence, and the model cannot directly request speech.

Useful AI overrides are:

```text
LIVE_ASSISTANT_AI_PROVIDER
LIVE_ASSISTANT_AI_BATCH_WINDOW_MS
LIVE_ASSISTANT_AI_MAX_BATCH_MESSAGES
LIVE_ASSISTANT_AI_MAX_BATCH_CHARS
LIVE_ASSISTANT_AI_REQUESTS_PER_MINUTE
LIVE_ASSISTANT_AI_REQUEST_TIMEOUT_MS
LIVE_ASSISTANT_OPENAI_MODEL
LIVE_ASSISTANT_OPENAI_REASONING_EFFORT
LIVE_ASSISTANT_OPENAI_BASE_URL
OPENAI_API_KEY
```

No test, `npm run validate`, `npm run demo`, or dashboard default makes a paid request. For an offline semantic dashboard fixture, run `npm run dashboard:ai-fixture`; its results are synthetic and are not model-quality evidence.

Livestream text and voice settings are never interpolated into PowerShell code. The provider starts `powershell.exe` with a fixed application-owned script and `shell: false`; Base64-encoded JSON travels through stdin. Child output is consumed and failure diagnostics are bounded.

## Local dashboard

Dashboard mode is explicit and additive. It starts a dependency-free local control server and keeps the process available until Ctrl+C:

```sh
npm run dashboard
node src/cli.js --dashboard --scenario=quiet-chat --speech=windows
node src/cli.js --dashboard --connector=tikfinity --speech=windows
node src/cli.js --dashboard --connector=tiktok-browser --tiktok-user=<USERNAME>
```

Open `http://127.0.0.1:4820/`. A completed simulator scenario remains visible in event history while speech drains normally. If TikFinity is unavailable, the dashboard remains online and reports the connector's reconnecting state.

The versioned API provides:

```text
GET  /api/v1/health
GET  /api/v1/status
GET  /api/v1/events?limit=100
GET  /api/v1/attention?limit=100
GET  /api/v1/stream
POST /api/v1/speech/pause
POST /api/v1/speech/resume
POST /api/v1/speech/clear
POST /api/v1/speech/cancel-current
```

Control POSTs require a JSON object such as `{}`. Browser requests must be same-origin; wildcard CORS is not enabled. Request bodies are limited to 4096 bytes. SSE sends an initial snapshot and selected operational updates. A backpressured client stops receiving updates until `drain`, then receives `stream-gap` and refetches snapshots/history rather than accumulating an application-level buffer.

The server defaults to loopback only. `LIVE_ASSISTANT_CONTROL_HOST` accepts only `127.0.0.1`, `localhost`, or `::1`; `LIVE_ASSISTANT_CONTROL_PORT` accepts ports `1` through `65535`. Invalid settings produce a diagnostic and use safe defaults. Ctrl+C closes the connector, speech worker and child process, HTTP listener, SSE clients, and runtime subscriptions.

Event and attention list responses are capped at 200 records and ordered oldest-to-newest within the selected recent window. Status exposes attention mode, traffic level, recent chat count, pending groups, and bounded decision-history count without message text. In AI mode it also exposes sanitized provider/model/state, in-flight and pending counts, last latency, usage counters, budget state, and fallback counts—never a key or prompt. SSE publishes safe `attention-decision` and `attention-state` projections. The dashboard retains the canonical event feed and adds attention/provider status, strategy, semantic/exact group kind, importance, decision feed, scoring factors, source IDs, fallback reason, and group detail. Upstream `raw` is omitted unless `LIVE_ASSISTANT_INSPECT_RAW=true` or `--include-raw` enabled it when the process started; query parameters cannot override that policy. Livestream values and raw JSON are rendered with DOM `textContent`, and the dashboard uses a restrictive Content Security Policy with no remote scripts, fonts, analytics, or runtime dependencies.

## Current scope

The foundation includes canonical events, raw and canonical simulator modes, a reconnecting native-WebSocket TikFinity adapter, a loopback-CDP authenticated Chrome TikTok adapter with local Webcast decoding and default media blocking, unknown-event preservation, a bounded ordered bus and separate history, deterministic Attention Phase 1, opt-in AI Attention Phase 2 with deterministic fallback, deterministic speech policy, a bounded provider-independent speech queue, a sequential speech worker, optional Windows local speech, a reusable application runtime, a loopback REST/SSE control plane, a static operational dashboard, structured diagnostics, and boundary-focused tests.

TikFinity, Webcast, and AI evaluation fixtures are synthetic and sanitized; field compatibility and semantic fixture output are intentionally limited to tested contracts. Invalid transport frames are diagnosed and skipped or converted to bounded unknown events as appropriate. Windows is the only implemented audio provider. AI chatbot replies, persistent AI memory, embeddings, vector databases, cloud speech, macOS/Linux speech, persistence, OBS, public network services, automatic TikTok login, cookie extraction, and anonymous direct TikTok connectivity remain unimplemented.
