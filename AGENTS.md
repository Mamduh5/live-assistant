# Live Assistant repository instructions

Before substantial changes, read `docs/PROJECT.md` and `docs/ARCHITECTURE.md`. Treat them as architectural constraints. If implementation and documentation disagree, identify whether the code drifted or the architecture should change; update both for meaningful architectural changes.

## Invariants

- External transports terminate at connector and normalizer boundaries.
- Generic code consumes canonical `LiveEvent` objects, never provider payload shapes.
- Preserve every upstream payload in `raw`; normalize unsupported or malformed inputs as inspectable `unknown` events.
- Use the canonical namespaced event types and v1 envelope defined in `docs/ARCHITECTURE.md`; treat that contract as an internal API.
- Keep connectors separate from attention, speech, OBS, UI, and business policy.
- Keep speech policy, bounded speech queues, and speech engines separate.
- Treat AI as optional. Deterministic ingestion, filtering, simulation, and outputs must work without it.
- Bind local servers to `127.0.0.1` by default. Do not add cloud dependencies without a concrete requirement.
- Bound in-memory queues, histories, and duplicate-tracking state. Preserve deterministic ordering.
- Treat operational failures as observable states where possible; one bad payload must not terminate the process.
- Centralize tunable values in configuration and provide safe defaults.
- Never commit credentials, cookies, tokens, session captures, private keys, or secret-bearing `.env` files.
- Do not introduce unofficial TikTok connectivity unless a task explicitly requires and documents that decision.
- Do not add frameworks, databases, desktop shells, microservices, or plugin runtimes for hypothetical needs.

## Working practices

Prefer one coherent vertical slice over broad scaffolding. Keep fixtures for raw connector data distinct from canonical fixtures. Test behavior at boundaries, including malformed inputs, unknown preservation, connector lifecycle, ordering, and bounds. Run `npm run validate` before claiming completion, and report any unrun or failing checks accurately.
