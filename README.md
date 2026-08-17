# Live Assistant

Live Assistant is a local-first foundation for turning livestream events into useful, bounded, streamer-facing information. Simulator mode runs entirely offline, and an optional TikFinity adapter can receive local TikTok LIVE events:

```text
SimulatorConnector -> canonical LiveEvent -> bounded LiveEventBus
                                         |-> bounded EventHistory
                                         `-> speech policy -> bounded SpeechQueue
                                                           `-> inspector

TikFinity Desktop -> TikFinityConnector -> TikFinityNormalizer
                                       -> the same LiveEventBus and consumers
```

## Requirements

- Node.js 22 or newer

There are no package dependencies and no account, livestream, AI provider, or external service is required.

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

TikFinity Desktop mode uses its local WebSocket endpoint and remains optional:

```sh
node src/cli.js --connector=tikfinity
```

The default endpoint is `ws://127.0.0.1:21213/`. If TikFinity is not running, Live Assistant remains alive, reports connection state, and retries with bounded exponential backoff. Press Ctrl+C to stop; explicit shutdown cancels reconnect attempts. Simulator mode remains the default.

Supported mappings are `chat` -> `chat.message`, `gift` -> `gift.received`, `share` -> `social.share`, `follow` -> `social.follow`, `like` -> `engagement.like`, `roomUser` -> `room.viewer_count`, and `subscribe` -> `subscription.started`. Unsupported and recognized-but-malformed envelopes become inspectable `platform.unknown` events. Every normalized event retains the complete `{ event, data }` envelope in `raw`.

Configuration is centralized in `src/config/defaults.js`. A small set of safe tuning values can be overridden through environment variables; invalid overrides fall back to defaults with a diagnostic. TikFinity supports `LIVE_ASSISTANT_TIKFINITY_URL`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS`, `LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER`, and `LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO`. Set `LIVE_ASSISTANT_INSPECT_RAW=true` or pass `--include-raw` to explicitly include upstream payloads in inspector output.

## Current scope

The foundation includes canonical events, raw and canonical simulator modes, a reconnecting native-WebSocket TikFinity adapter, unknown-event preservation, a bounded ordered bus and separate history, deterministic speech policy, a bounded provider-independent speech queue, structured diagnostics, and boundary-focused tests.

TikFinity fixtures are synthetic and sanitized; field compatibility is intentionally limited to the documented semantics covered by tests. Invalid JSON and frames without a valid event name are diagnosed and skipped at the transport boundary. Real speech playback, AI, a UI, persistence, OBS, public network services, and direct TikTok connectivity remain unimplemented.
