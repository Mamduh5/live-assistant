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

The first foundation provides an offline path from a simulator through canonical events to a deterministic filter and event inspector. This validates the replaceable boundaries and creates a development loop that needs no real livestream.

Future vertical slices may add a bounded speech queue and replaceable local speech engine, then an optional TikFinity adapter. AI, OBS, a visual UI, direct TikTok connectivity, databases, accounts, cloud hosting, and additional platforms are not part of the initial foundation.

## Success criteria

- Connectors can change without rewriting attention or output policy.
- Output engines can change without changing connectors.
- Simulator development does not require TikFinity, OBS, or AI.
- Unknown and malformed inputs remain inspectable.
- Traffic cannot create unbounded queues or history.
- Event behavior is deterministic, observable, and testable.

