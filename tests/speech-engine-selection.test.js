import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  WindowsSystemSpeechEngine,
  createSpeechEngine,
  resolveSpeechEngineType,
} from "../src/index.js";

test("speech playback is off by default", () => {
  assert.equal(resolveSpeechEngineType(undefined, DEFAULT_CONFIG.speechEngine.type), "off");
  assert.equal(createSpeechEngine({ type: "off", config: DEFAULT_CONFIG.speechEngine }), null);
});

test("CLI-style windows selection creates the Windows provider", () => {
  assert.equal(resolveSpeechEngineType("windows", "off"), "windows");
  const engine = createSpeechEngine({
    type: "windows",
    config: DEFAULT_CONFIG.speechEngine,
    windowsDependencies: { platform: "win32", spawn() {} },
  });
  assert.equal(engine instanceof WindowsSystemSpeechEngine, true);
});

test("rejects unknown speech engine selections", () => {
  assert.throws(() => resolveSpeechEngineType("cloud", "off"), /Unsupported speech engine/);
});

