import { spawn as spawnProcess } from "node:child_process";
import { SpeechEngineError } from "./speech-engine.js";

const MAX_PROCESS_OUTPUT = 4_096;

export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$encodedPayload = [Console]::In.ReadToEnd()
$jsonPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))
$payload = $jsonPayload | ConvertFrom-Json
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voiceName = [string]$payload.voice
  if ($null -ne $payload.voice -and $voiceName.Length -gt 0) {
    $synthesizer.SelectVoice($voiceName)
  }
  $synthesizer.Rate = [int]$payload.rate
  $synthesizer.Volume = [int]$payload.volume
  $synthesizer.Speak([string]$payload.text)
}
finally {
  $synthesizer.Dispose()
}
`.trim();

const WINDOWS_SPEECH_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  WINDOWS_SPEECH_SCRIPT,
]);

function abortError() {
  return new DOMException("Speech playback was cancelled", "AbortError");
}

function boundedAppend(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_PROCESS_OUTPUT);
}

function processFailureMessage(prefix, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`.slice(0, MAX_PROCESS_OUTPUT);
}

function validateOptions({ executable, voice, rate, volume }) {
  if (typeof executable !== "string" || executable.length === 0) throw new TypeError("Windows speech executable is required");
  if (voice !== null && voice !== undefined && (typeof voice !== "string" || voice.length === 0)) throw new TypeError("Windows speech voice must be null or a non-empty string");
  if (!Number.isSafeInteger(rate) || rate < -10 || rate > 10) throw new RangeError("Windows speech rate must be an integer from -10 to 10");
  if (!Number.isSafeInteger(volume) || volume < 0 || volume > 100) throw new RangeError("Windows speech volume must be an integer from 0 to 100");
}

export class WindowsSystemSpeechEngine {
  #executable;
  #voice;
  #rate;
  #volume;
  #platform;
  #spawn;
  #active = new Map();
  #closed = false;
  #closePromise;

  constructor({ executable = "powershell.exe", voice = null, rate = 0, volume = 100, platform = process.platform, spawn = spawnProcess } = {}) {
    validateOptions({ executable, voice, rate, volume });
    this.#executable = executable;
    this.#voice = voice;
    this.#rate = rate;
    this.#volume = volume;
    this.#platform = platform;
    this.#spawn = spawn;
  }

  speak(text, { signal } = {}) {
    if (typeof text !== "string" || text.length === 0) {
      return Promise.reject(new TypeError("Speech text must be a non-empty string"));
    }
    if (this.#platform !== "win32") {
      return Promise.reject(new SpeechEngineError("Windows system speech is only available on Windows", {
        code: "speech_engine.unsupported_platform",
        permanent: true,
      }));
    }
    if (this.#closed) {
      return Promise.reject(new SpeechEngineError("Windows system speech engine is closed", {
        code: "speech_engine.unavailable",
        permanent: true,
      }));
    }
    if (signal?.aborted) return Promise.reject(abortError());

    let child;
    try {
      child = this.#spawn(this.#executable, [...WINDOWS_SPEECH_ARGUMENTS], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(new SpeechEngineError(processFailureMessage("Unable to start Windows system speech", error), {
        code: "speech_engine.unavailable",
        permanent: true,
        cause: error,
      }));
    }

    if (!child || typeof child.once !== "function" || typeof child.kill !== "function" || !child.stdin) {
      return Promise.reject(new SpeechEngineError("Speech process did not provide the required process interface", {
        code: "speech_engine.unavailable",
        permanent: true,
      }));
    }

    let stderr = "";
    let settled = false;
    let cancelled = false;
    const onStdout = () => {};
    const onStderr = (chunk) => { stderr = boundedAppend(stderr, chunk); };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    let cancel;
    const completion = new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };

      cancel = () => {
        if (cancelled || settled) return;
        cancelled = true;
        try {
          child.kill();
        } catch {
          finish(abortError());
        }
      };

      child.once("error", (error) => finish(new SpeechEngineError(processFailureMessage("Windows speech process could not start", error), {
        code: "speech_engine.unavailable",
        permanent: true,
        cause: error,
      })));
      child.once("close", (code, processSignal) => {
        if (cancelled || signal?.aborted || this.#closed) {
          finish(abortError());
        } else if (code === 0) {
          finish();
        } else {
          const detail = stderr.trim();
          finish(new SpeechEngineError(
            `Windows speech process failed with exit code ${code ?? "unknown"}${processSignal ? ` (${processSignal})` : ""}${detail ? `: ${detail}` : ""}`,
            { code: "speech_engine.process_failed" },
          ));
        }
      });
      child.stdin.on?.("error", (error) => {
        if (!cancelled) {
          finish(new SpeechEngineError("Unable to send data to Windows speech process", {
            code: "speech_engine.process_failed",
            cause: error,
          }));
          try { child.kill(); } catch { /* The process may already be gone. */ }
        }
      });

      signal?.addEventListener("abort", cancel, { once: true });
      const payload = Buffer.from(JSON.stringify({ text, voice: this.#voice, rate: this.#rate, volume: this.#volume }), "utf8").toString("base64");
      try {
        child.stdin.end(payload, "utf8");
      } catch (error) {
        finish(new SpeechEngineError("Unable to send data to Windows speech process", {
          code: "speech_engine.process_failed",
          cause: error,
        }));
      }
    });

    const entry = { cancel: () => cancel(), completion };
    this.#active.set(child, entry);
    return completion.finally(() => {
      this.#active.delete(child);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const active = [...this.#active.values()];
      for (const entry of active) entry.cancel();
      await Promise.allSettled(active.map(({ completion }) => completion));
    })();
    return this.#closePromise;
  }
}
