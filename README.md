# Live Assistant

Live Assistant is a local-first foundation for turning livestream events into useful, bounded, streamer-facing information. Simulator mode runs entirely offline, and an optional TikFinity adapter can receive local TikTok LIVE events:

```text
SimulatorConnector -> canonical LiveEvent -> bounded LiveEventBus
                                         |-> bounded EventHistory
                                         `-> speech policy -> bounded SpeechQueue
                                                           |-> SpeechWorker
                                                           |    `-> optional Windows system TTS
                                                           `-> inspector

TikFinity Desktop -> TikFinityConnector -> TikFinityNormalizer
                                       -> the same LiveEventBus and consumers

TikFinity / Simulator -> LiveAssistantRuntime -> local control server
                                             |-> REST + SSE
                                             `-> browser dashboard
```

## Requirements

- Node.js 22 or newer

There are no package dependencies and no account, livestream, AI provider, or external service is required.

Local audio playback currently requires Windows PowerShell and an installed `System.Speech` voice. Speech remains off by default.

## Run it

```sh
npm run demo
npm test
npm run validate
```

Available simulator scenarios are `quiet-chat`, `mixed-burst`, and `malformed-input`:

```sh
npm start -- malformed-input
node src/cli.js malformed-input --include-raw
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

Configuration is centralized in `src/config/defaults.js`. A small set of safe tuning values can be overridden through environment variables; invalid overrides fall back to defaults with a diagnostic. TikFinity supports `LIVE_ASSISTANT_TIKFINITY_URL`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER`, and `LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO`. Set `LIVE_ASSISTANT_INSPECT_RAW=true` or pass `--include-raw` to explicitly include upstream payloads in inspector output.

Speech supports `LIVE_ASSISTANT_SPEECH_ENGINE=off|windows`, `LIVE_ASSISTANT_SPEECH_VOICE`, `LIVE_ASSISTANT_SPEECH_RATE` (`-10` to `10`), and `LIVE_ASSISTANT_SPEECH_VOLUME` (`0` to `100`). `--speech=off|windows` overrides the configured engine for one CLI run. The default voice is the Windows system default, rate is `0`, and volume is `100`.

Speech requests remain FIFO. The worker waits without polling, speaks one request at a time, and isolates ordinary provider failures. A finite connector run closes the producer side and drains queued speech before exit. Ctrl+C cancels the active PowerShell child, clears remaining speech, and exits promptly.

Livestream text and voice settings are never interpolated into PowerShell code. The provider starts `powershell.exe` with a fixed application-owned script and `shell: false`; Base64-encoded JSON travels through stdin. Child output is consumed and failure diagnostics are bounded.

## Local dashboard

Dashboard mode is explicit and additive. It starts a dependency-free local control server and keeps the process available until Ctrl+C:

```sh
npm run dashboard
node src/cli.js --dashboard --scenario=quiet-chat --speech=windows
node src/cli.js --dashboard --connector=tikfinity --speech=windows
```

Open `http://127.0.0.1:4820/`. A completed simulator scenario remains visible in event history while speech drains normally. If TikFinity is unavailable, the dashboard remains online and reports the connector's reconnecting state.

The versioned API provides:

```text
GET  /api/v1/health
GET  /api/v1/status
GET  /api/v1/events?limit=100
GET  /api/v1/stream
POST /api/v1/speech/pause
POST /api/v1/speech/resume
POST /api/v1/speech/clear
POST /api/v1/speech/cancel-current
```

Control POSTs require a JSON object such as `{}`. Browser requests must be same-origin; wildcard CORS is not enabled. Request bodies are limited to 4096 bytes. SSE sends an initial snapshot and selected operational updates. A backpressured client stops receiving updates until `drain`, then receives `stream-gap` and refetches snapshots/history rather than accumulating an application-level buffer.

The server defaults to loopback only. `LIVE_ASSISTANT_CONTROL_HOST` accepts only `127.0.0.1`, `localhost`, or `::1`; `LIVE_ASSISTANT_CONTROL_PORT` accepts ports `1` through `65535`. Invalid settings produce a diagnostic and use safe defaults. Ctrl+C closes the connector, speech worker and child process, HTTP listener, SSE clients, and runtime subscriptions.

Event list responses are capped at 200 records and ordered oldest-to-newest within the selected recent window. Upstream `raw` is omitted unless `LIVE_ASSISTANT_INSPECT_RAW=true` or `--include-raw` enabled it when the process started; query parameters cannot override that policy. Livestream values and raw JSON are rendered with DOM `textContent`, and the dashboard uses a restrictive Content Security Policy with no remote scripts, fonts, analytics, or runtime dependencies.

## Current scope

The foundation includes canonical events, raw and canonical simulator modes, a reconnecting native-WebSocket TikFinity adapter, unknown-event preservation, a bounded ordered bus and separate history, deterministic speech policy, a bounded provider-independent speech queue, a sequential speech worker, optional Windows local speech, a reusable application runtime, a loopback REST/SSE control plane, a static operational dashboard, structured diagnostics, and boundary-focused tests.

TikFinity fixtures are synthetic and sanitized; field compatibility is intentionally limited to the documented semantics covered by tests. Invalid JSON and frames without a valid event name are diagnosed and skipped at the transport boundary. Windows is the only implemented audio provider. AI, cloud speech, macOS/Linux speech, persistence, OBS, public network services, and direct TikTok connectivity remain unimplemented.
