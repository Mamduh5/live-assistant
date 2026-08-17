# 0006 - Deterministic Attention Engine Phase 1

Status: accepted

## Context

Live Assistant needs to reduce chat noise and expose why an item deserves attention before adding external AI. Sending every chat message directly to speech cannot group repeated questions or adapt selection pressure to traffic. Putting those concerns in connectors would couple product behavior to providers, while putting them in speech engines would mix selection with playback safety.

## Decision

Introduce this provider-independent path:

```text
canonical LiveEvent
  -> AttentionEngine
  -> AttentionDecision
  -> SpeechCandidate
  -> final DeterministicSpeechPolicy
  -> SpeechQueue
```

`AttentionEngine` owns bounded recent-chat and pending-group state, traffic measurement, fixed-window timers, lifecycle flush/close behavior, and bounded decision history. `DeterministicAttentionPolicy` owns classification, configured explainable scoring, thresholds, reasons, and deterministic candidate formatting.

Phase 1 groups questions only by exact-normalized text. Normalization is limited to Unicode normalization, whitespace cleanup, case folding, and terminal question-punctuation normalization. Repetition importance counts distinct stable canonical users; missing identity is never fabricated. Traffic-aware thresholds become stricter as bounded recent volume moves from quiet to busy to very busy. Pending-group overflow flushes the oldest group with a diagnostic.

Attention selects what deserves consideration. Final speech policy independently retains URL, length, duplicate, cooldown, disabled-user, and queue-pressure protections. Attention priority is propagated as metadata while the queue remains FIFO. Attention decisions remain observable when speech is disabled or paused.

## Non-goals

Deterministic Attention is not semantic AI. Phase 1 has no LLM, embeddings, semantic similarity, fuzzy intent guessing, translation, sentiment model, AI summary, or chatbot reply. Semantically equivalent but textually different questions may remain separate.

This decision also does not add persistence, dynamic tuning UI, priority scheduling, OBS, cloud speech, or new platform transports.

## Consequences

- Behavior is deterministic, explainable, bounded, and testable with injected time and ID generation.
- The dashboard and API can show what arrived versus what attention promoted or ignored.
- Finite sources must flush pending groups before downstream drain; shutdown must cancel timers.
- A future AI policy can replace or augment decision policy without learning provider fields or bypassing speech safety.
- Exact matching deliberately misses some human-equivalent questions until a separately approved semantic implementation exists.
