# 0001 — Canonical LiveEvent v1

Status: accepted

## Context

Live Assistant must accept provider-specific livestream data while keeping history, policy, speech, UI, and future integrations independent of TikFinity or any platform payload.

## Decision

Use the namespaced, schema-versioned event envelope documented in `docs/ARCHITECTURE.md`. Generate IDs locally, represent source and receipt time as Unix milliseconds, use the bounded `LiveUser` shape, and preserve the complete source payload in `raw`. Normalize unsupported and malformed input as `platform.unknown` with a reason and optional native event name.

## Consequences

Every connector requires an explicit normalization boundary. Consumers gain one stable contract and can inspect new provider behavior without data loss. Raw data may contain sensitive or noisy information, so it is excluded from normal logs and exposed only through explicit inspection.

