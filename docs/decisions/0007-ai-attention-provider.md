# 0007 - AI attention provider and bounded semantic batches

Status: accepted

## Context

Deterministic Attention Phase 1 intentionally groups only exact-normalized questions. The product now needs semantic grouping and concise streamer-facing summaries without coupling connectors, runtime lifecycle, speech safety, or application contracts to a model vendor. Remote inference adds latency, cost, privacy, availability, and untrusted-output concerns; event ingestion cannot wait for it.

## Decision

Use this boundary:

```text
canonical LiveEvent
  -> synchronous bounded AiAttentionBatcher admission
  -> AiAttentionProvider
  -> OpenAI Responses API
  -> strict validated semantic result
  -> canonical AttentionDecision / SpeechCandidate
  -> final DeterministicSpeechPolicy
```

AI mode is explicit and the default remains passthrough. `observe()` enqueues compact items and returns without awaiting network latency. Exact-normalized duplicates are pre-compressed. Batch time, messages, items, characters, pending work, concurrency, summary length, response bytes, request rate, and decision history all have hard bounds. A finite source flushes its partial batch and waits for bounded in-flight work before speech drain. Explicit shutdown aborts active inference and emits no late decisions.

The first provider uses Node's native fetch and the OpenAI Responses API. Requests use a source-controlled instruction, separate serialized viewer-data input, strict JSON Schema Structured Outputs, `store: false`, no background mode, no response continuation, and an empty tool set. The model returns semantic grouping, classification, importance, a small reason enum, and a summary. The application validates every input item appears exactly once, rejects unknown/duplicate/missing mappings and invalid fields, derives canonical event/viewer counts locally, compares importance with existing traffic thresholds, and formats trustworthy count prefixes locally.

Provider timeout, refusal, network/HTTP error, invalid output, oversized response, batch overflow, rate-budget exhaustion, or open circuit invokes the existing deterministic policy for the affected exact-compressed items. Fallback strategy and reason are visible. There are no automatic retries. Three consecutive provider failures open the circuit for a 30-second default cooldown; one sequential probe is allowed afterward.

## Privacy and security

- Send only local item ID, chat text, local occurrence/viewer counts, and classification hint.
- Keep source event IDs and all user identity mapping local.
- Never send `LiveEvent.raw`, usernames, display names, avatar URLs, connector internals, or provider metadata.
- Treat viewer text as untrusted data, never model instructions.
- Keep `OPENAI_API_KEY` only in process environment/Authorization header and out of config, status, diagnostics, API, SSE, and dashboard.
- Bound response reads and retain only safe status/code/request-ID metadata on failures.
- Do not request or retain chain-of-thought.

## Consequences

Semantic grouping can recognize equivalent viewer intent and reduce repeated output across textually different messages. It also introduces an external network dependency, data egress, latency, API cost, and non-deterministic model behavior. Deterministic fallback keeps connectors, history, dashboard, and speech operational during degradation. Transport and final speech policy remain independent. Automated tests and the offline dashboard fixture use synthetic providers and never spend API credits.

This decision does not add chatbot replies, persistent memory, embeddings, a vector database, dynamic AI switching, a prompt editor, OBS, or new platform transports.
