# Live Assistant

Live Assistant is a local-first foundation for turning livestream events into useful, bounded, streamer-facing information. The current vertical slice runs entirely offline:

```text
SimulatorConnector -> canonical LiveEvent -> bounded LiveEventBus
                                         |-> bounded EventHistory
                                         `-> speech policy -> bounded SpeechQueue
                                                           `-> inspector
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

Configuration is centralized in `src/config/defaults.js`. A small set of safe tuning values can be overridden through environment variables; invalid overrides fall back to defaults with a diagnostic. Set `LIVE_ASSISTANT_INSPECT_RAW=true` or pass `--include-raw` to explicitly include upstream payloads in inspector output.

## Current scope

The foundation includes canonical events, raw and canonical simulator modes, an adapter boundary, unknown-event preservation, a bounded ordered bus and separate history, deterministic speech policy, a bounded provider-independent speech queue, simulator scenarios, structured diagnostics, and boundary-focused tests.

It intentionally does not include TikFinity transport, real speech playback, AI, a UI, persistence, OBS, or public network services. Those remain replaceable adapters or later domain layers.
