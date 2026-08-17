# Architecture

## Core flow

```text
external source -> Connector -> Normalizer -> canonical LiveEvent
                                            -> LiveEventBus
                                            -> domain consumers
                                            -> attention/rules/actions
                                            -> output adapters
```

Connectors own transport and lifecycle only. Normalizers are the sole translation boundary for external field names. Domain consumers receive canonical events. Outputs consume domain decisions and never own application policy.

## Canonical event contract

`LiveEvent` is an internal API. Version 1 has stable envelope fields:

- `schemaVersion`, `id`, `type`, `platform`
- `occurredAt`, `receivedAt`
- `source` with connector identity and optional native event name
- nullable canonical `actor`
- type-specific canonical `data`
- original `raw` payload

Supported types are `chat.message`, `gift`, `follow`, `subscription`, `like`, `share`, `room.viewer_count`, and `unknown`. Additive evolution is preferred. Persisted or externally exposed representations must retain the schema version.

Malformed inputs and unsupported native event names normalize to `unknown` with a reason. They are diagnostics, not process-fatal exceptions.

## Processing guarantees

`LiveEventBus` dispatches events and subscribers in registration order. Its pending queue and delivered-event history are bounded. The configured overflow policy drops the oldest pending event and emits a diagnostic. Subscriber failures are isolated and observable.

The initial deterministic filter suppresses empty chat and repeated normalized chat text inside a configurable window. Its tracking state is bounded. It is a domain consumer, not connector behavior.

## Configuration and operations

Safe defaults live in `src/config/defaults.js`. Configuration errors fall back to defaults and are reported. Diagnostics are structured JSON. No server or external connection exists in this slice; any future local server must bind to `127.0.0.1` by default.

## Extension points

- A connector exposes an async `events(signal)` iterable and an identity.
- A normalizer maps one connector payload to one canonical event.
- Event-bus subscribers implement domain policy or projections.
- Future speech policy will emit requests to a bounded speech queue; a separate engine will play them.

The simulator deliberately uses the same connector-normalizer-bus path intended for real transports.

