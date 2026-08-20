# Live Assistant product

Live Assistant is a local-first assistant for livestreamers. TikTok LIVE is the first target, and TikFinity may later serve as an optional local input adapter. Neither TikTok nor TikFinity defines the core domain.

The product exists to reduce the attention demanded by chat. It should turn noisy event streams into concise, useful information and actions through deterministic policy first and optional AI reasoning later.

## Product direction

```text
Live platforms
  -> connectors
  -> Live ORM (normalization)
  -> session/event state
  -> attention
  -> rules/actions
  -> output adapters
```

"Live ORM" means the normalization layer, not a database ORM. It gives the rest of the application stable representations of chat, gifts, follows, subscriptions, likes, shares, room statistics, and unknown provider events.

## Initial development loop

The foundation provides a path from simulator or TikFinity events through bounded history, deterministic Attention Engine Phase 1, final deterministic speech policy, a bounded queue, sequential speech worker, and optional Windows local audio. A reusable runtime coordinates those components and projects bounded status, event and attention history, diagnostics, and speech controls to an optional loopback REST/SSE server and static browser dashboard. Both inputs use the same canonical consumers without changing the domain model.

Deterministic attention reduces obvious noise before any external AI is introduced. It uses bounded recent-chat state, exact-normalized question groups, stable-viewer repetition, traffic-aware thresholds, and explainable scores. It emits an `AttentionDecision`, then a `SpeechCandidate`; speech policy remains the independent safety and rate-control gate. **Deterministic Attention is not semantic AI.** Textually different questions remain separate even when a person would understand them as similar.

AI Attention Phase 2 now implements that policy seam through bounded semantic batches and an optional OpenAI Responses API provider. It can group same-intent chat and produce short streamer-facing summaries, while the application owns thresholds, reliable counts, fallback, and final speech safety. This introduces opt-in external processing, latency, cost, and model variability without making AI required infrastructure.

AI chatbot replies, persistent AI memory, embeddings, vector databases, prompt editing, dynamic provider switching, OBS, persistent settings, anonymous/direct TikTok authentication, databases, accounts, cloud hosting, and additional platforms remain outside the current foundation. The implemented TikTok browser connector is read-only observation of an authenticated local Chrome transport, not a direct TikTok client.

## Success criteria

- Connectors can change without rewriting attention or output policy.
- Output engines can change without changing connectors.
- Simulator development does not require TikFinity, OBS, or AI.
- Unknown and malformed inputs remain inspectable.
- Traffic cannot create unbounded queues or history.
- Event behavior is deterministic, observable, and testable.
