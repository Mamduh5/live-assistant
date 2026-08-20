import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSpeechScript,
  discoverWindowsModernSpeechVoices,
  discoverWindowsSystemSpeechVoices,
  selectWindowsSpeechVoice,
} from "../src/index.js";

const VOICES = [
  { name: "Microsoft David", language: "en-US", gender: "Male", backend: "legacy", enabled: true },
  { name: "Microsoft Pattara", language: "th-TH", gender: "Male", backend: "modern", id: "modern-pattara", enabled: true },
  { name: "Thai Alternate", language: "th-TH", gender: "Female", backend: "modern", id: "modern-thai-alt", enabled: true },
  { name: "Disabled Thai", language: "th-TH", enabled: false },
];

test("script detection conservatively distinguishes Thai, Latin, mixed, and unknown text", () => {
  assert.equal(detectSpeechScript("สวัสดีครับ"), "thai");
  assert.equal(detectSpeechScript("hello world"), "english");
  assert.equal(detectSpeechScript("hello สวัสดี"), "mixed");
  assert.equal(detectSpeechScript("123 !!!"), "unknown");
});

test("language selection chooses installed Thai and English voices deterministically", () => {
  assert.equal(selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES }).voice.name, "Microsoft Pattara");
  assert.equal(selectWindowsSpeechVoice({ text: "hello", voices: VOICES }).voice.name, "Microsoft David");
});

test("global override wins when language-appropriate and rejects an English voice for Thai", () => {
  const appropriate = selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES, voice: "Thai Alternate" });
  assert.equal(appropriate.voice.name, "Thai Alternate");
  const mismatch = selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES, voice: "Microsoft David" });
  assert.equal(mismatch.voice.name, "Microsoft Pattara");
  assert.equal(mismatch.diagnostics[0].reason, "configured_voice_language_mismatch");
});

test("configured Thai and English language overrides are deterministic", () => {
  assert.equal(selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES, languageVoices: { th: "Thai Alternate" } }).voice.name, "Thai Alternate");
  assert.equal(selectWindowsSpeechVoice({ text: "hello", voices: VOICES, languageVoices: { en: "Microsoft David" } }).voice.name, "Microsoft David");
});

test("missing Thai remains observable and is not sent to an English voice", () => {
  const result = selectWindowsSpeechVoice({
    text: "สวัสดี",
    voices: [VOICES[0]],
    languageVoices: { en: "Microsoft David", th: "Missing Thai" },
  });
  assert.equal(result.voice, null);
  assert.equal(result.diagnostics.some(({ requestedLanguage }) => requestedLanguage === "th-TH"), true);
});

test("mixed and unsupported text safely use an English fallback", () => {
  assert.equal(selectWindowsSpeechVoice({ text: "hello สวัสดี", voices: VOICES }).voice.name, "Microsoft David");
  assert.equal(selectWindowsSpeechVoice({ text: "123 !!!", voices: VOICES }).voice.name, "Microsoft David");
});

test("modern discovery sanitizes Pattara and David voice metadata", async () => {
  const voices = await discoverWindowsModernSpeechVoices({
    platform: "win32",
    execFile(executable, args, options, callback) {
      assert.equal(options.shell, false);
      assert.equal(args.includes("-STA"), true);
      callback(null, JSON.stringify([
        { name: "Microsoft Pattara", language: "th-TH", gender: "Male", id: "pattara-id", backend: "modern", enabled: true, registryPath: "secret" },
        { name: "Microsoft David", language: "en-US", gender: "Male", id: "david-id", backend: "modern", enabled: true },
      ]));
    },
  });
  assert.deepEqual(voices.map(({ name, language, backend }) => ({ name, language, backend })), [
    { name: "Microsoft Pattara", language: "th-TH", backend: "modern" },
    { name: "Microsoft David", language: "en-US", backend: "modern" },
  ]);
  assert.equal(JSON.stringify(voices).includes("registry"), false);
  assert.equal(JSON.stringify(voices).includes("pattara-id"), false);
});

test("voice discovery returns only sanitized System.Speech metadata", async () => {
  let call;
  const voices = await discoverWindowsSystemSpeechVoices({
    platform: "win32",
    execFile(executable, args, options, callback) {
      call = { executable, args, options };
      callback(null, JSON.stringify({ name: "Synthetic Voice", language: "th-TH", gender: "Female", enabled: true, registryPath: "secret" }));
    },
  });
  assert.equal(call.executable, "powershell.exe");
  assert.equal(call.options.shell, false);
  assert.deepEqual(voices, [{ name: "Synthetic Voice", language: "th-TH", gender: "Female", enabled: true }]);
  assert.equal(JSON.stringify(voices).includes("registry"), false);
});
