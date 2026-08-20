import { execFile as execFileProcess } from "node:child_process";
import { SpeechEngineError } from "./speech-engine.js";

export const WINDOWS_VOICE_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  @($synthesizer.GetInstalledVoices() | ForEach-Object {
    [PSCustomObject]@{
      name = [string]$_.VoiceInfo.Name
      language = [string]$_.VoiceInfo.Culture.Name
      gender = [string]$_.VoiceInfo.Gender
      enabled = [bool]$_.Enabled
    }
  }) | ConvertTo-Json -Compress
}
finally {
  $synthesizer.Dispose()
}
`.trim();

export const WINDOWS_MODERN_VOICE_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
@([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
  [PSCustomObject]@{
    name = [string]$_.DisplayName
    language = [string]$_.Language
    gender = [string]$_.Gender
    backend = 'modern'
    enabled = $true
  }
}) | ConvertTo-Json -Compress
`.trim();

const DISCOVERY_ARGUMENTS = Object.freeze([
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_VOICE_DISCOVERY_SCRIPT,
]);

const MODERN_DISCOVERY_ARGUMENTS = Object.freeze([
  "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_MODERN_VOICE_DISCOVERY_SCRIPT,
]);

export function sanitizeWindowsVoiceInventory(value) {
  const records = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return records.flatMap((voice) => {
    if (!voice || typeof voice.name !== "string" || voice.name.length === 0 || typeof voice.language !== "string") return [];
    return [{
      name: voice.name.slice(0, 200),
      language: voice.language.slice(0, 35),
      ...(typeof voice.gender === "string" && voice.gender.length > 0 ? { gender: voice.gender.slice(0, 30) } : {}),
      ...(voice.backend === "modern" ? { backend: "modern" } : {}),
      enabled: voice.enabled !== false,
    }];
  });
}

export function discoverWindowsModernSpeechVoices({
  executable = "powershell.exe",
  platform = process.platform,
  execFile = execFileProcess,
  signal,
} = {}) {
  if (platform !== "win32") return Promise.reject(new SpeechEngineError("Modern Windows voice discovery is only available on Windows", { code: "speech_engine.unsupported_platform", permanent: true }));
  return new Promise((resolve, reject) => {
    const done = (error, stdout) => {
      if (error) {
        reject(new SpeechEngineError("Unable to enumerate modern Windows voices", { code: "speech.modern_backend_unavailable", cause: error }));
        return;
      }
      try { resolve(sanitizeWindowsVoiceInventory(JSON.parse(stdout || "[]"))); }
      catch (cause) { reject(new SpeechEngineError("Modern Windows voice discovery returned invalid data", { code: "speech.modern_backend_unavailable", cause })); }
    };
    try {
      execFile(executable, [...MODERN_DISCOVERY_ARGUMENTS], { shell: false, windowsHide: true, encoding: "utf8", maxBuffer: 65_536, signal }, done);
    } catch (cause) {
      reject(new SpeechEngineError("Unable to enumerate modern Windows voices", { code: "speech.modern_backend_unavailable", cause }));
    }
  });
}

export function discoverWindowsSystemSpeechVoices({
  executable = "powershell.exe",
  platform = process.platform,
  execFile = execFileProcess,
  signal,
} = {}) {
  if (platform !== "win32") return Promise.reject(new SpeechEngineError("Windows voice discovery is only available on Windows", { code: "speech_engine.unsupported_platform", permanent: true }));
  return new Promise((resolve, reject) => {
    try {
      execFile(executable, [...DISCOVERY_ARGUMENTS], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 65_536,
        signal,
      }, (error, stdout) => {
        if (error) {
          reject(new SpeechEngineError("Unable to enumerate Windows System.Speech voices", { code: "speech_engine.voice_discovery_failed", cause: error }));
          return;
        }
        try {
          resolve(sanitizeWindowsVoiceInventory(JSON.parse(stdout || "[]")));
        } catch (cause) {
          reject(new SpeechEngineError("Windows voice discovery returned invalid data", { code: "speech_engine.voice_discovery_failed", cause }));
        }
      });
    } catch (cause) {
      reject(new SpeechEngineError("Unable to enumerate Windows System.Speech voices", { code: "speech_engine.voice_discovery_failed", cause }));
    }
  });
}
