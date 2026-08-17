import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WINDOWS_SPEECH_SCRIPT, WindowsSystemSpeechEngine } from "../src/index.js";

class MockChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdinChunks = [];
  killCalls = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.stdinChunks.push(Buffer.from(chunk)));
  }

  kill() {
    this.killCalls += 1;
    this.emit("close", null, "SIGTERM");
    return true;
  }

  inputPayload() {
    const encoded = Buffer.concat(this.stdinChunks).toString("utf8");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  }
}

function spawnHarness() {
  const calls = [];
  const children = [];
  return {
    calls,
    children,
    spawn(executable, args, options) {
      const child = new MockChild();
      calls.push({ executable, args, options });
      children.push(child);
      return child;
    },
  };
}

test("uses powershell.exe without a shell and sends hostile speech text only through stdin", async () => {
  const harness = spawnHarness();
  const hostile = "$(Get-Process); Remove-Item something\n\"; Write-Output hacked; \"\n' & calc.exe";
  const engine = new WindowsSystemSpeechEngine({ platform: "win32", spawn: harness.spawn });
  const speaking = engine.speak(hostile);

  assert.equal(harness.calls[0].executable, "powershell.exe");
  assert.equal(harness.calls[0].options.shell, false);
  assert.equal(harness.calls[0].options.windowsHide, true);
  assert.equal(harness.calls[0].args.includes(WINDOWS_SPEECH_SCRIPT), true);
  assert.equal(JSON.stringify(harness.calls[0].args).includes(hostile), false);
  assert.equal(WINDOWS_SPEECH_SCRIPT.includes(hostile), false);
  assert.equal(harness.children[0].inputPayload().text, hostile);

  harness.children[0].emit("close", 0, null);
  await speaking;
  await engine.close();
});

test("passes voice, rate, and volume as stdin data rather than executable code", async () => {
  const harness = spawnHarness();
  const engine = new WindowsSystemSpeechEngine({
    platform: "win32",
    spawn: harness.spawn,
    voice: "Synthetic Voice'; Write-Output nope",
    rate: -3,
    volume: 42,
  });
  const speaking = engine.speak("hello");
  const payload = harness.children[0].inputPayload();
  assert.deepEqual(payload, {
    text: "hello",
    voice: "Synthetic Voice'; Write-Output nope",
    rate: -3,
    volume: 42,
  });
  assert.equal(JSON.stringify(harness.calls[0].args).includes(payload.voice), false);
  harness.children[0].emit("close", 0, null);
  await speaking;
});

test("rejects non-zero process exits with bounded structured failure", async () => {
  const harness = spawnHarness();
  const engine = new WindowsSystemSpeechEngine({ platform: "win32", spawn: harness.spawn });
  const speaking = engine.speak("hello");
  harness.children[0].stderr.write("provider failed");
  harness.children[0].emit("close", 1, null);
  await assert.rejects(speaking, (error) => {
    assert.equal(error.code, "speech_engine.process_failed");
    assert.match(error.message, /provider failed/);
    return true;
  });
});

test("handles synchronous and emitted spawn failures as engine unavailability", async () => {
  const synchronous = new WindowsSystemSpeechEngine({
    platform: "win32",
    spawn() { throw new Error("missing executable"); },
  });
  await assert.rejects(synchronous.speak("hello"), (error) => {
    assert.equal(error.code, "speech_engine.unavailable");
    assert.equal(error.permanent, true);
    return true;
  });

  const harness = spawnHarness();
  const emitted = new WindowsSystemSpeechEngine({ platform: "win32", spawn: harness.spawn });
  const speaking = emitted.speak("hello");
  harness.children[0].emit("error", new Error("ENOENT"));
  await assert.rejects(speaking, { code: "speech_engine.unavailable" });
});

test("AbortSignal kills active PowerShell and rejects as cancellation", async () => {
  const harness = spawnHarness();
  const controller = new AbortController();
  const engine = new WindowsSystemSpeechEngine({ platform: "win32", spawn: harness.spawn });
  const speaking = engine.speak("hello", { signal: controller.signal });
  controller.abort();
  await assert.rejects(speaking, { name: "AbortError" });
  assert.equal(harness.children[0].killCalls, 1);
});

test("close kills active children and is idempotent", async () => {
  const harness = spawnHarness();
  const engine = new WindowsSystemSpeechEngine({ platform: "win32", spawn: harness.spawn });
  const speaking = engine.speak("hello");
  const rejected = assert.rejects(speaking, { name: "AbortError" });
  const firstClose = engine.close();
  const secondClose = engine.close();
  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, rejected]);
  assert.equal(harness.children[0].killCalls, 1);
});

test("reports unsupported platforms without spawning a process", async () => {
  let spawnCalls = 0;
  const engine = new WindowsSystemSpeechEngine({
    platform: "linux",
    spawn() { spawnCalls += 1; },
  });
  await assert.rejects(engine.speak("hello"), (error) => {
    assert.equal(error.code, "speech_engine.unsupported_platform");
    assert.equal(error.permanent, true);
    return true;
  });
  assert.equal(spawnCalls, 0);
});

