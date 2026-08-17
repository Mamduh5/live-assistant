# 0005 — Loopback REST/SSE control plane and static dashboard

Status: accepted

## Context

Live Assistant needs a streamer/operator interface and a stable seam for future local integrations without coupling browser code to connectors, queues, speech providers, or other private runtime objects. Terminal JSON alone is not an effective operational interface.

## Decision

Use one reusable `LiveAssistantRuntime` for CLI and dashboard composition. Add a dependency-free Node HTTP server bound to loopback, REST under `/api/v1/` for bounded snapshots and commands, Server-Sent Events for selected real-time state/events, and a same-origin static dashboard. Dashboard mode is explicit and does not alter normal finite simulator behavior.

The browser and HTTP server are adapters. Canonical event interpretation, status projection, speech lifecycle, queue mutation, and control semantics remain in application/domain modules.

## Security

- Bind to `127.0.0.1` by default and reject configured non-loopback hosts.
- Do not enable wildcard or permissive CORS.
- Require JSON and same-origin browser semantics for state-changing requests while intentionally allowing local non-browser clients without `Origin`.
- Bound command bodies, event reads, diagnostics, SSE client count, histories, and queues.
- Omit provider `raw` unless process-level inspection explicitly enabled it.
- Render untrusted livestream and JSON values only as text under a restrictive Content Security Policy.
- On SSE backpressure, drop subsequent client updates and emit a resync signal after drain instead of building an application buffer.

## Consequences

Live Assistant gains a durable local operational surface for richer UI, future OBS browser sources, Attention Engine visibility, and other local tools. Native HTTP, SSE, and static assets keep startup and supply-chain cost small. The API is intentionally shaped and versioned, which requires maintaining compatibility deliberately. This decision does not imply public network access, remote administration, settings persistence, dynamic connector switching, AI, or OBS support.
