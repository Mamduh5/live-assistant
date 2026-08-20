# 0004 — Windows system speech as the first audio provider

Status: accepted

## Context

The deterministic speech policy and bounded queue already produce provider-independent speech requests, but the application needs real local playback without cloud accounts, API keys, network services, or npm TTS dependencies.

## Decision

Introduce a small `SpeechEngine` convention and a sequential `SpeechWorker`. The first provider remains `WindowsSystemSpeechEngine`, but internally uses modern `Windows.Media.SpeechSynthesis` voices and retains legacy `System.Speech` as an English fallback. Playback remains off by default and the provider is explicitly Windows-only. Per-utterance Unicode script classification selects installed `th-*` or `en-*` voices; Pattara is preferred for automatic Thai selection. Mixed and unknown input use a deterministic English fallback.

## Security

Livestream-controlled text is untrusted data. The child process is started with `spawn`, `shell: false`, and a fixed application-owned PowerShell program. Text, voice, rate, and volume are UTF-8 JSON encoded as Base64 and sent only through stdin. They are never concatenated into PowerShell source or executable arguments. Child output is consumed, and diagnostic capture is bounded.

## Consequences

- Playback works locally and offline with zero new npm dependencies.
- Queueing, worker lifecycle, and provider behavior remain independently replaceable.
- Modern discovery runs in a fresh STA PowerShell helper. This corrected the earlier ad-hoc probe: the production helper discovers Microsoft Pattara as `th-TH` on the validation machine.
- Modern synthesis uses `SynthesizeTextToStreamAsync`, the WinRT `AsTask` bridge, documented speaking-rate/audio-volume options, a randomized OS-temporary WAV, synchronous local playback, and redundant helper/parent deletion.
- Safe discovery returns only sanitized voice metadata and excludes registry-shaped voice IDs. Missing matches emit `speech.voice_unavailable`; WinRT initialization/playback failures emit `speech.modern_backend_unavailable`.
- English may fall back to legacy `System.Speech`. Thai is not silently routed to David/Zira when Pattara is known but the modern backend fails.
- One process per utterance has startup overhead but avoids persistent IPC, daemon recovery, and a larger attack surface.
- Cloud, browser, macOS, and Linux providers can be added later without changing policy or queue semantics.
