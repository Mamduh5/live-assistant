const THAI_SCRIPT = /[\u0E00-\u0E7F]/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;

export function detectSpeechScript(text) {
  if (typeof text !== "string") return "unknown";
  const hasThai = THAI_SCRIPT.test(text);
  const hasLatin = LATIN_SCRIPT.test(text);
  if (hasThai && hasLatin) return "mixed";
  if (hasThai) return "thai";
  if (hasLatin) return "english";
  return "unknown";
}

function enabledVoices(voices) {
  if (!Array.isArray(voices)) return [];
  return voices.filter((voice) => voice && typeof voice.name === "string" && voice.name.length > 0 && voice.enabled !== false);
}

function byName(voices, name) {
  if (typeof name !== "string" || name.length === 0) return null;
  const normalized = name.toLocaleLowerCase("en-US");
  return voices.find((voice) => voice.name.toLocaleLowerCase("en-US") === normalized) ?? null;
}

function byLanguage(voices, language) {
  return voices.find((voice) => typeof voice.language === "string" && voice.language.toLocaleLowerCase("en-US").startsWith(`${language}-`)) ?? null;
}

export function selectWindowsSpeechVoice({ text, voices, voice = null, languageVoices = {} }) {
  const available = enabledVoices(voices);
  const classification = detectSpeechScript(text);
  const diagnostics = [];
  const explicit = byName(available, voice);
  if (voice && !explicit) diagnostics.push({ code: "speech.voice_unavailable", requestedLanguage: "configured", reason: "configured_voice_not_installed" });
  if (explicit) return { classification, voice: explicit, diagnostics };

  const requestedLanguage = classification === "thai" ? "th-TH" : classification === "english" ? "en-US" : null;
  const key = classification === "thai" ? "th" : classification === "english" ? "en" : null;
  const preferredName = key ? languageVoices?.[key] : null;
  let selected = byName(available, preferredName);
  if (preferredName && !selected) diagnostics.push({ code: "speech.voice_unavailable", requestedLanguage, reason: "configured_language_voice_not_installed" });
  if (!selected && key) selected = byLanguage(available, key);

  if (classification === "thai" && !selected) {
    diagnostics.push({ code: "speech.voice_unavailable", requestedLanguage: "th-TH", reason: "language_voice_not_installed" });
  }

  if (!selected) selected = byName(available, languageVoices?.en) ?? byLanguage(available, "en");
  return { classification, voice: selected, diagnostics };
}
