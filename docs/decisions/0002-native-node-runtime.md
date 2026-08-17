# 0002 — Native Node.js runtime for the initial foundation

Status: accepted

## Context

The initial slice needs local event processing, async connectors, structured output, configuration, and tests. It does not yet need a browser UI, server framework, database, desktop shell, or third-party runtime library.

## Decision

Use Node.js 22 or newer, native ESM JavaScript, and the built-in test runner with no package dependencies. Keep package-manager usage limited to reproducible scripts.

## Consequences

The project starts quickly and works offline with a small supply-chain surface. Static checking is currently syntax-level rather than TypeScript-level. A later UI or API requirement may justify TypeScript or additional libraries; that change must be evaluated and documented rather than assumed.

