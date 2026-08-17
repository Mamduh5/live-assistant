# 0003 — TikFinity as an optional TikTok LIVE adapter

Status: accepted

## Context

TikFinity Desktop provides a practical first source of real TikTok LIVE events through a local WebSocket stream. Live Assistant needs real traffic without adopting TikFinity's event names as application semantics or introducing TikTok credentials and reverse-engineered transport dependencies.

## Decision

Implement TikFinity as an optional connector at `ws://127.0.0.1:21213/` by default. Use Node.js's native WebSocket client, a dedicated TikFinity normalizer, configurable bounded reconnect behavior, and the existing canonical event pipeline. Preserve complete valid TikFinity envelopes in `raw`; diagnose and skip invalid JSON or frames without an event name.

## Consequences

TikFinity offers quick access to real TikTok LIVE traffic when its desktop application is running. Its availability and payload compatibility remain external operational dependencies, while simulator development continues offline. Application consumers remain independent of TikFinity schemas, and a direct TikTok connector remains explicitly deferred.
