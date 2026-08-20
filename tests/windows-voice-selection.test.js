import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSpeechScript,
  discoverWindowsSystemSpeechVoices,
  selectWindowsSpeechVoice,
} from "../src/index.js";

const VOICES = [
  { name: "English One", language: "en-US", gender: "Female", enabled: true },
  { name: "Thai One", language: "th-TH", gender: "Female", enabled: true },
  { name: "Disabled Thai", language: "th-TH", enabled: false },
];

test("script detection conservatively distinguishes Thai, Latin, mixed, and unknown text", () => {
  assert.equal(detectSpeechScript("สวัสดีครับ"), "thai");
  assert.equal(detectSpeechScript("hello world"), "english");
  assert.equal(detectSpeechScript("hello สวัสดี"), "mixed");
  assert.equal(detectSpeechScript("123 !!!"), "unknown");
});

test("language selection chooses installed Thai and English voices deterministically", () => {
  assert.equal(selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES }).voice.name, "Thai One");
  assert.equal(selectWindowsSpeechVoice({ text: "hello", voices: VOICES }).voice.name, "English One");
});

test("global configured voice overrides automatic language selection", () => {
  const result = selectWindowsSpeechVoice({ text: "สวัสดี", voices: VOICES, voice: "English One" });
  assert.equal(result.voice.name, "English One");
  assert.deepEqual(result.diagnostics, []);
});

test("missing Thai uses the configured/default English fallback and stays observable", () => {
  const result = selectWindowsSpeechVoice({
    text: "สวัสดี",
    voices: [VOICES[0]],
    languageVoices: { en: "English One", th: "Missing Thai" },
  });
  assert.equal(result.voice.name, "English One");
  assert.equal(result.diagnostics.some(({ requestedLanguage }) => requestedLanguage === "th-TH"), true);
});

test("mixed and unsupported text safely use an English fallback", () => {
  assert.equal(selectWindowsSpeechVoice({ text: "hello สวัสดี", voices: VOICES }).voice.name, "English One");
  assert.equal(selectWindowsSpeechVoice({ text: "123 !!!", voices: VOICES }).voice.name, "English One");
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
