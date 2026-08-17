# Live Assistant architecture

Status: initial implemented architecture.

## System overview

```text
External source -> Connector -> Normalizer -> canonical LiveEvent -> LiveEventBus
                                                                  |-> EventHistory
                                                                  |-> Session state (future)
                                                                  `-> Consumers
                                                                       -> deterministic policy
                                                                       -> action routing (future)
                                                                       -> output adapters
```

Each layer remains independently replaceable where practical. The application starts as one local process; distributed messaging, persistence, cloud services, and a heavyweight UI are not justified.

## Application runtime and local control plane

`LiveAssistantRuntime` is the single application composition used by the CLI and optional dashboard. It coordinates the connector, event bus, bounded history, deterministic speech policy, queue, worker, engine, lifecycle cancellation, status projection, and control operations. Provider parsing remains in normalizers, playback remains in speech engines, and HTTP/HTML concerns remain in adapters.

```text
TikFinity / Simulator -> LiveAssistantRuntime
                         |-> canonical event pipeline
                         |-> bounded speech pipeline
                         `-> status and control projection
                                  |
                           LocalControlServer
                            |-> REST snapshots/commands
                            |-> SSE operational updates
                            `-> same-origin static dashboard
```

The native `node:http` server binds to `127.0.0.1:4820` by default and uses `/api/v1/` as a durable local API namespace. Dashboard mode must be requested explicitly. A finite simulator completes and drains speech while its runtime history remains available; a reconnecting or unavailable TikFinity adapter does not take down the dashboard.

REST exposes health, sanitized status, capped recent-event projections, and speech controls. SSE immediately sends a snapshot, then selected live-event, connector, speech, and diagnostic projections. The server subscribes once to the runtime and fans out to bounded clients. When a response reports backpressure, subsequent updates for that client are counted rather than queued; after `drain`, one `stream-gap` event instructs the browser to refetch status/history. Disconnect and shutdown remove response and runtime listeners.

Pause gates the worker between utterances and stops the runtime from accepting new speech requests; chat received while paused remains in event history and is not replayed on resume. Existing waiting requests remain until resumed or explicitly cleared. Clear removes only waiting requests. Cancel-current aborts only the active engine call, after which the worker accepts future requests.

The server has no wildcard CORS. Browser control commands must be same-origin, reject cross-site fetch metadata, use JSON, and fit within a 4096-byte body. Non-browser loopback tools without browser origin headers remain intentionally usable. Static responses use a restrictive CSP, `nosniff`, frame denial, and no-referrer policy. Browser code creates DOM nodes and assigns untrusted livestream values through `textContent`, never HTML parsing.

Event API projections include canonical fields and a domain-owned display summary. Raw provider values are excluded unless process-level raw inspection was explicitly enabled; browser query parameters cannot elevate that policy. Public diagnostics are allowlisted projections without stack traces, chat text, environment values, or child-process output. See [ADR 0005](decisions/0005-local-control-plane.md).

## Connector layer

Connectors establish and close external connections, report connection state, receive raw events, reconnect where appropriate, and surface transport errors. They do not implement speech, attention, actions, OBS behavior, or UI state.

Implemented inputs are the simulator and the optional TikFinity Desktop adapter. Direct TikTok, YouTube Live, and Twitch transports are not selected.

`TikFinityConnector` uses Node's native WebSocket client to connect to `ws://127.0.0.1:21213/` by default. It owns JSON framing, top-level envelope validation, lifecycle state, cancellation, and reconnect scheduling. Unexpected failure uses configurable exponential backoff with bounded jitter; a successful connection resets the delay. Explicit close or abort stops the socket and all reconnect attempts. TikFinity being unavailable is an observable offline state, not an application-fatal error.

Invalid JSON and objects without a non-empty `event` name are diagnosed and skipped at the transport boundary. They cannot be meaningfully normalized as TikFinity envelopes and are not logged as raw text. Every valid envelope is passed to `TikFinityNormalizer`, even when its `data` is missing or malformed.

The simulator is first-class and has two distinct modes:

- `SimulatorConnector` generates canonical events for application behavior.
- `RawSimulatorConnector` generates connector-shaped input for normalizer tests.

Both report lifecycle state and support cancellation. The canonical simulator enters the same process-local bus used by real normalized events.

## Normalization layer

Each real connector has its own normalizer. A normalizer owns provider-field extraction and converts exactly one upstream payload into one canonical event. Unsupported or malformed input becomes `platform.unknown`; it is never silently discarded. The complete input remains in `raw`.

`TikFinityNormalizer` maps `chat`, `gift`, `share`, `follow`, `like`, `roomUser`, and `subscribe` into the existing canonical namespace. It preserves the complete `{ event, data }` envelope as `raw`. Gift repeat updates describe upstream streak state but are not aggregated into transactions. Unsupported event names and recognized events with invalid required data remain distinguishable unknown events.

Normalization reports what the upstream event represents. Aggregation—especially gift streak completion—is a later session/domain responsibility.

## Canonical LiveEvent v1

`LiveEvent` is an internal API whose v1 envelope contains:

```text
id             locally generated, locally unique string
schemaVersion  1
platform       canonical platform identifier
connector      connector identity
type           namespaced canonical event type
timestamp      source time in Unix milliseconds when trustworthy,
               otherwise local receipt time
receivedAt     local receipt time in Unix milliseconds
user           optional canonical LiveUser
data           type-specific canonical data
raw            complete upstream input
```

The initial event namespace is:

```text
chat.message
gift.received
social.follow
social.share
engagement.like
subscription.started
room.viewer_count
platform.unknown
```

`LiveUser` includes only broadly useful optional attributes: `id`, `username`, `displayName`, `avatarUrl`, `isFollower`, `isSubscriber`, and `isModerator`. Provider-only metadata stays in `raw`.

An unknown event retains connector, platform, receipt time, raw payload, and its native event name when known. See [ADR 0001](decisions/0001-canonical-live-event-v1.md).

## Event bus and history

`LiveEventBus` is process-local. It supports publishing, subscribing to all events, subscribing by canonical type, and unsubscribing. Events and matching subscribers are invoked in deterministic registration order. The pending queue is bounded; overflow drops the oldest pending event with a structured diagnostic. Subscriber failures are isolated.

`EventHistory` is a separate canonical-event consumer. It retains the most recent 500 events by default, with a configurable bound. Persistent recording is not implied.

## Session state

A future session-state consumer may derive viewer count, connected platforms, recent active users, complete gift streaks, stream timing, topics, and assistant status. Connectors must not own this global state.

## Deterministic policy and speech

The AI Attention Engine remains unimplemented until its requirements are concrete. Initial safety and noise control are deterministic.

```text
LiveEvent -> DeterministicSpeechPolicy -> SpeechRequest -> SpeechQueue
                                                       -> SpeechWorker
                                                       -> SpeechEngine
                                                       -> audio provider
```

The policy currently handles supported event types, empty chat, URLs, maximum length, exact normalized duplicates, per-user cooldown, disabled users, and queue pressure. It returns an inspectable decision with a reason and priority. It does not play audio.

`SpeechQueue` is bounded, FIFO, and provider-independent. It provides notification-based waiting rather than polling. Closing the producer side drains existing requests and then ends the worker; immediate cancellation clears the backlog and aborts active playback.

`SpeechWorker` is the only queue consumer. It awaits each engine call before taking the next request, preventing overlap. Ordinary request failures are diagnosed and isolated so later speech can continue. Permanent engine unavailability closes the queue rather than creating a repeated failure loop.

`WindowsSystemSpeechEngine` is the first concrete provider. It launches one non-interactive Windows PowerShell process per utterance and uses `System.Speech.Synthesis.SpeechSynthesizer`. PowerShell source is fixed and application-owned. All dynamic values—including untrusted livestream text and configured voice names—are UTF-8 JSON encoded as Base64 and supplied through child stdin. The process is spawned with `shell: false`; stdout is consumed and stderr diagnostics are bounded. Abort or close terminates active children. See [ADR 0004](decisions/0004-windows-system-speech-engine.md).

Speech playback is off by default. The Windows engine is intentionally unsupported on macOS and Linux; other providers can implement the same `speak(text, { signal })` and `close()` convention later.

## Future boundaries

- Attention may consume canonical events, session state, queue pressure, and recent output. AI extends deterministic controls and cannot become transport infrastructure.
- Rules/actions consume canonical events and decisions, never provider payloads.
- OBS remains an output adapter through a future local overlay API and/or OBS WebSocket.
- The local API may later add simulation, selected configuration, or overlay state without exposing runtime internals directly. It remains loopback-only by default.
- Persistence will be selected only for a concrete settings, rules, profile, analytics, recording, or memory requirement.
- Network connectors should use configurable bounded exponential backoff with jitter, explicit disconnect, maximum delay, healthy-reset behavior, and observable state.

## Observability

Structured diagnostics expose connector lifecycle, normalization failures, queue overflow, subscriber failure, policy decisions, queued actions, and execution results. Raw payload logging is opt-in.

## Current decisions

- TikFinity is an optional adapter, not the domain.
- Canonical events preserve raw input.
- The simulator is first-class.
- Core operation is local-first.
- AI is optional.
- OBS is an adapter.
- Configuration is centralized and validated at startup.
- The initial runtime is dependency-free Node.js ESM; see [ADR 0002](decisions/0002-native-node-runtime.md).
- TikFinity is an optional local WebSocket adapter; see [ADR 0003](decisions/0003-tikfinity-adapter.md).
- Speech engines are replaceable, with Windows System.Speech as the first local provider; see [ADR 0004](decisions/0004-windows-system-speech-engine.md).
- Local operations use a loopback REST/SSE control plane and same-origin static dashboard; see [ADR 0005](decisions/0005-local-control-plane.md).

Frontend frameworks, desktop shells, HTTP server libraries, non-Windows TTS providers, persistence, direct TikTok transport, deployment, and plugin runtime remain undecided.
