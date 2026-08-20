import { spawn as spawnProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SpeechEngineError } from "./speech-engine.js";
import { detectSpeechScript } from "./windows-voice-selection.js";

const MAX_PROCESS_OUTPUT = 4_096;

export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$encodedPayload = [Console]::In.ReadToEnd()
$jsonPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))
$payload = $jsonPayload | ConvertFrom-Json
function Report-Diagnostic([string]$code, [string]$language, [string]$reason) {
  [Console]::Out.WriteLine(([PSCustomObject]@{ code = $code; requestedLanguage = $language; reason = $reason } | ConvertTo-Json -Compress))
}
function Find-ByName($voices, [string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $null }
  return $voices | Where-Object { $_.name -ieq $name } | Select-Object -First 1
}
function Find-ByLanguage($voices, [string]$language) {
  return $voices | Where-Object { $_.language -like "$language-*" } | Select-Object -First 1
}

Add-Type -AssemblyName System.Speech
$legacySynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$legacyVoices = @($legacySynth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
  [PSCustomObject]@{ name = [string]$_.VoiceInfo.Name; language = [string]$_.VoiceInfo.Culture.Name; backend = 'legacy'; handle = $_ }
})
$modernVoices = @()
$modernFailure = $null
try {
  [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
  $modernVoices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
    [PSCustomObject]@{ name = [string]$_.DisplayName; language = [string]$_.Language; backend = 'modern'; handle = $_ }
  })
}
catch { $modernFailure = 'initialization_failed' }

try {
  $voices = @($modernVoices) + @($legacyVoices)
  $classification = [string]$payload.classification
  $selected = Find-ByName $voices ([string]$payload.voice)
  if ($null -ne $selected -and $classification -eq 'thai' -and $selected.language -notlike 'th-*') {
    Report-Diagnostic 'speech.voice_unavailable' 'th-TH' 'configured_voice_language_mismatch'
    $selected = $null
  }
  elseif ($null -eq $selected -and -not [string]::IsNullOrWhiteSpace([string]$payload.voice)) {
    Report-Diagnostic 'speech.voice_unavailable' 'configured' 'configured_voice_not_installed'
  }

  $language = if ($classification -eq 'thai') { 'th' } elseif ($classification -eq 'english') { 'en' } else { $null }
  if ($null -eq $selected -and $null -ne $language) {
    $preferred = [string]$payload.languageVoices.$language
    $selected = Find-ByName $voices $preferred
    if ($null -eq $selected -and -not [string]::IsNullOrWhiteSpace($preferred)) {
      Report-Diagnostic 'speech.voice_unavailable' $(if ($language -eq 'th') { 'th-TH' } else { 'en-US' }) 'configured_language_voice_not_installed'
    }
  }
  if ($null -eq $selected -and $language -eq 'th') {
    $selected = $modernVoices | Where-Object { $_.language -like 'th-*' -and $_.name -like '*Pattara*' } | Select-Object -First 1
    if ($null -eq $selected) { $selected = Find-ByLanguage $voices 'th' }
  }
  if ($null -eq $selected -and $language -eq 'en') { $selected = Find-ByLanguage $voices 'en' }
  if ($null -eq $selected -and ($classification -eq 'mixed' -or $classification -eq 'unknown')) {
    $selected = Find-ByName $voices ([string]$payload.languageVoices.en)
    if ($null -eq $selected) { $selected = Find-ByLanguage $voices 'en' }
  }

  if ($null -eq $selected -and $classification -eq 'thai') {
    if ($null -ne $modernFailure) { Report-Diagnostic 'speech.modern_backend_unavailable' 'th-TH' $modernFailure }
    else { Report-Diagnostic 'speech.voice_unavailable' 'th-TH' 'language_voice_not_installed' }
    throw 'No usable Thai speech voice is available'
  }
  if ($null -eq $selected) { $selected = $legacyVoices | Select-Object -First 1 }

  if ($selected.backend -eq 'modern') {
    try {
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $modernSynth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
      try {
        $modernSynth.Voice = $selected.handle
        $modernSynth.Options.SpeakingRate = [double]$payload.modernRate
        $modernSynth.Options.AudioVolume = [double]$payload.modernVolume
        $operation = $modernSynth.SynthesizeTextToStreamAsync([string]$payload.text)
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
          $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
          $_.GetParameters()[0].ParameterType.IsGenericType -and
          $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq ('Windows.Foundation.IAsyncOperation' + [char]96 + '1')
        } | Select-Object -First 1
        if ($null -eq $asTask) { throw 'WinRT AsTask adapter unavailable' }
        $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($operation))
        $speechStream = $task.GetAwaiter().GetResult()
        try {
          $managedStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($speechStream)
          try {
            $fileStream = [IO.File]::Create([string]$payload.tempPath)
            try { $managedStream.CopyTo($fileStream) } finally { $fileStream.Dispose() }
          } finally { $managedStream.Dispose() }
        } finally { $speechStream.Dispose() }
        $player = New-Object System.Media.SoundPlayer ([string]$payload.tempPath)
        $player.PlaySync()
      } finally { $modernSynth.Dispose() }
    }
    catch {
      Report-Diagnostic 'speech.modern_backend_unavailable' $(if ($classification -eq 'thai') { 'th-TH' } else { 'en-US' }) 'playback_failed'
      if ($classification -eq 'thai') { throw }
      $fallback = Find-ByLanguage $legacyVoices 'en'
      if ($null -eq $fallback) { throw }
      $legacySynth.SelectVoice($fallback.name)
      $legacySynth.Rate = [int]$payload.rate
      $legacySynth.Volume = [int]$payload.volume
      $legacySynth.Speak([string]$payload.text)
    }
  }
  else {
    $legacySynth.SelectVoice($selected.name)
    $legacySynth.Rate = [int]$payload.rate
    $legacySynth.Volume = [int]$payload.volume
    $legacySynth.Speak([string]$payload.text)
  }
}
finally {
  $legacySynth.Dispose()
  Remove-Item -LiteralPath ([string]$payload.tempPath) -Force -ErrorAction SilentlyContinue
}
`.trim();

const WINDOWS_SPEECH_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-STA",
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

export function mapWindowsModernRate(rate) {
  if (!Number.isSafeInteger(rate) || rate < -10 || rate > 10) throw new RangeError("Windows speech rate must be an integer from -10 to 10");
  return rate < 0 ? 1 + rate * 0.05 : 1 + rate * 0.5;
}

export function mapWindowsModernVolume(volume) {
  if (!Number.isSafeInteger(volume) || volume < 0 || volume > 100) throw new RangeError("Windows speech volume must be an integer from 0 to 100");
  return volume / 100;
}

function validateOptions({ executable, voice, languageVoices, rate, volume }) {
  if (typeof executable !== "string" || executable.length === 0) throw new TypeError("Windows speech executable is required");
  if (voice !== null && voice !== undefined && (typeof voice !== "string" || voice.length === 0)) throw new TypeError("Windows speech voice must be null or a non-empty string");
  if (!languageVoices || typeof languageVoices !== "object" || Array.isArray(languageVoices)) throw new TypeError("Windows speech language voices must be an object");
  for (const language of ["en", "th"]) {
    const value = languageVoices[language];
    if (value !== null && value !== undefined && (typeof value !== "string" || value.length === 0)) throw new TypeError(`Windows ${language} speech voice must be null or a non-empty string`);
  }
  if (!Number.isSafeInteger(rate) || rate < -10 || rate > 10) throw new RangeError("Windows speech rate must be an integer from -10 to 10");
  if (!Number.isSafeInteger(volume) || volume < 0 || volume > 100) throw new RangeError("Windows speech volume must be an integer from 0 to 100");
}

export class WindowsSystemSpeechEngine {
  #executable;
  #voice;
  #languageVoices;
  #rate;
  #volume;
  #platform;
  #spawn;
  #active = new Map();
  #closed = false;
  #closePromise;
  #onDiagnostic;

  constructor({ executable = "powershell.exe", voice = null, languageVoices = { en: null, th: null }, rate = 0, volume = 100,
    platform = process.platform, spawn = spawnProcess, onDiagnostic = () => {} } = {}) {
    validateOptions({ executable, voice, languageVoices, rate, volume });
    this.#executable = executable;
    this.#voice = voice;
    this.#languageVoices = { en: languageVoices.en ?? null, th: languageVoices.th ?? null };
    this.#rate = rate;
    this.#volume = volume;
    this.#platform = platform;
    this.#spawn = spawn;
    this.#onDiagnostic = onDiagnostic;
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
    const tempPath = join(tmpdir(), `live-assistant-speech-${randomUUID()}.wav`);
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
    let stdout = "";
    const onStdout = (chunk) => { stdout = boundedAppend(stdout, chunk); };
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
          this.#reportProcessDiagnostics(stdout);
          finish();
        } else {
          this.#reportProcessDiagnostics(stdout);
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
      const payload = Buffer.from(JSON.stringify({
        text,
        voice: this.#voice,
        languageVoices: this.#languageVoices,
        classification: detectSpeechScript(text),
        rate: this.#rate,
        volume: this.#volume,
        modernRate: mapWindowsModernRate(this.#rate),
        modernVolume: mapWindowsModernVolume(this.#volume),
        tempPath,
      }), "utf8").toString("base64");
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
    return completion.finally(async () => {
      this.#active.delete(child);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      try { await unlink(tempPath); } catch (error) { if (error?.code !== "ENOENT") this.#onDiagnostic({ code: "speech.temp_cleanup_failed" }); }
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

  #reportProcessDiagnostics(output) {
    for (const line of output.split(/\r?\n/u)) {
      try {
        const value = JSON.parse(line);
        if (["speech.voice_unavailable", "speech.modern_backend_unavailable"].includes(value?.code) && typeof value.requestedLanguage === "string") {
          this.#onDiagnostic({ code: value.code, requestedLanguage: value.requestedLanguage, ...(typeof value.reason === "string" ? { reason: value.reason } : {}) });
        }
      } catch { /* Other process output is intentionally ignored. */ }
    }
  }
}
