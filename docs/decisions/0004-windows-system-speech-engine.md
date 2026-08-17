# 0004 — Windows system speech as the first audio provider

Status: accepted

## Context

The deterministic speech policy and bounded queue already produce provider-independent speech requests, but the application needs real local playback without cloud accounts, API keys, network services, or npm TTS dependencies.

## Decision

Introduce a small `SpeechEngine` convention and a sequential `SpeechWorker`. The first provider is `WindowsSystemSpeechEngine`, using one non-interactive Windows PowerShell process and `System.Speech.Synthesis.SpeechSynthesizer` per utterance. Playback remains off by default and the provider is explicitly Windows-only.

## Security

Livestream-controlled text is untrusted data. The child process is started with `spawn`, `shell: false`, and a fixed application-owned PowerShell program. Text, voice, rate, and volume are UTF-8 JSON encoded as Base64 and sent only through stdin. They are never concatenated into PowerShell source or executable arguments. Child output is consumed, and diagnostic capture is bounded.

## Consequences

- Playback works locally and offline with zero new npm dependencies.
- Queueing, worker lifecycle, and provider behavior remain independently replaceable.
- The first provider requires Windows PowerShell, `System.Speech`, and an installed local voice.
- One process per utterance has startup overhead but avoids persistent IPC, daemon recovery, and a larger attack surface.
- Cloud, browser, macOS, and Linux providers can be added later without changing policy or queue semantics.
