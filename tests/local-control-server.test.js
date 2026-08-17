import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalControlServer, RuntimeControlError, SseBroker } from "../src/index.js";

function until(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (predicate()) return resolve();
      if (++attempts > 100) return reject(new Error("Timed out waiting for server state"));
      setImmediate(check);
    };
    check();
  });
}

class StubRuntime {
  subscribers = [];
  calls = [];
  status = {
    runtime: { state: "running", startedAt: 1 },
    connector: { name: "simulator", state: "connected" },
    speech: { configuredEngine: "windows", enabled: true, paused: false, workerState: "idle", queueSize: 0, currentRequestId: null },
    events: { historySize: 1, rawInspectionEnabled: false },
  };

  getStatus() { return structuredClone(this.status); }
  getRecentEvents({ limit }) { return [{ id: "event-1", type: "chat.message", summary: "hello" }].slice(-limit); }
  getSnapshot() { return { status: this.getStatus(), events: this.getRecentEvents({ limit: 100 }), diagnostics: [] }; }
  subscribe(handler) { this.subscribers.push(handler); return () => { this.subscribers = this.subscribers.filter((item) => item !== handler); }; }
  emit(type, data) { for (const handler of [...this.subscribers]) handler({ type, data }); }
  pauseSpeech() { this.calls.push("pause"); this.status.speech.paused = true; return this.status.speech; }
  resumeSpeech() { this.calls.push("resume"); this.status.speech.paused = false; return this.status.speech; }
  clearSpeechQueue() { this.calls.push("clear"); return { cleared: 3, queueSize: 0 }; }
  cancelCurrentSpeech() { this.calls.push("cancel"); return { cancelled: true, currentRequestId: "request-1" }; }
}

async function fixture() {
  const runtime = new StubRuntime();
  const diagnostics = [];
  const server = new LocalControlServer({ runtime, port: 0, onDiagnostic: (value) => diagnostics.push(value) });
  const url = await server.start();
  return { runtime, server, url, diagnostics };
}

test("serves versioned health, status, bounded events, method errors, and unknown routes on loopback", async () => {
  const { server, url } = await fixture();
  try {
    assert.equal(server.host, "127.0.0.1");
    const health = await fetch(`${url}api/v1/health`);
    assert.deepEqual(await health.json(), { ok: true });
    const status = await fetch(`${url}api/v1/status`);
    assert.equal((await status.json()).connector.name, "simulator");
    const events = await fetch(`${url}api/v1/events?limit=999`);
    assert.equal((await events.json()).events.length, 1);
    const forcedRaw = await fetch(`${url}api/v1/events?limit=1&includeRaw=true`);
    assert.equal("raw" in (await forcedRaw.json()).events[0], false);
    const wrongMethod = await fetch(`${url}api/v1/health`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
    const missing = await fetch(`${url}api/v1/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test("speech controls require bounded JSON and reject cross-origin browser requests", async () => {
  const { runtime, server, url } = await fixture();
  const post = (path, options = {}) => fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body ?? "{}",
  });
  try {
    const pause = await post("api/v1/speech/pause", { headers: { Origin: url.slice(0, -1), "Sec-Fetch-Site": "same-origin" } });
    assert.equal(pause.status, 200);
    assert.deepEqual(runtime.calls, ["pause"]);
    assert.equal((await post("api/v1/speech/resume")).status, 200);
    assert.equal((await post("api/v1/speech/clear")).status, 200);
    assert.equal((await post("api/v1/speech/cancel-current")).status, 200);
    assert.deepEqual(runtime.calls, ["pause", "resume", "clear", "cancel"]);
    const foreign = await post("api/v1/speech/resume", { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
    assert.equal(foreign.status, 403);
    assert.deepEqual(runtime.calls, ["pause", "resume", "clear", "cancel"]);
    assert.equal((await post("api/v1/speech/clear", { body: "{" })).status, 400);
    assert.equal((await fetch(`${url}api/v1/speech/clear`, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await post("api/v1/speech/clear", { body: JSON.stringify({ padding: "x".repeat(5000) }) })).status, 413);
  } finally {
    await server.stop();
  }
});

test("events expose raw only when the runtime's server-side policy includes it", async () => {
  const { runtime, server, url } = await fixture();
  runtime.status.events.rawInspectionEnabled = true;
  runtime.getRecentEvents = () => [{ id: "raw-1", type: "chat.message", summary: "hello", raw: { allowed: true } }];
  try {
    const response = await fetch(`${url}api/v1/events?includeRaw=false`);
    assert.deepEqual((await response.json()).events[0].raw, { allowed: true });
  } finally {
    await server.stop();
  }
});

test("maps unavailable runtime controls to a structured non-200 response", async () => {
  const { runtime, server, url } = await fixture();
  runtime.pauseSpeech = () => { throw new RuntimeControlError("speech_not_available", "Speech is not enabled"); };
  try {
    const response = await fetch(`${url}api/v1/speech/pause`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "speech_not_available");
  } finally {
    await server.stop();
  }
});

test("reports a port binding failure without creating a runtime subscription", async () => {
  const first = await fixture();
  const occupiedPort = Number(new URL(first.url).port);
  const secondRuntime = new StubRuntime();
  const second = new LocalControlServer({ runtime: secondRuntime, port: occupiedPort });
  try {
    await assert.rejects(second.start(), (error) => error?.code === "EADDRINUSE");
    assert.equal(secondRuntime.subscribers.length, 0);
  } finally {
    await second.stop();
    await first.server.stop();
  }
});

test("SSE sends an initial snapshot and state updates, cleans disconnected clients, and closes on shutdown", async () => {
  const { runtime, server, url } = await fixture();
  const response = await fetch(`${url}api/v1/stream`);
  const reader = response.body.getReader();
  try {
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: snapshot/);
    runtime.emit("live-event", { id: "live-2" });
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /event: live-event/);
    runtime.emit("speech-state", { workerState: "speaking" });
    const stateUpdate = new TextDecoder().decode((await reader.read()).value);
    assert.match(stateUpdate, /event: speech-state/);
    await reader.cancel();
    await until(() => server.sseClientCount === 0);
    const shutdownResponse = await fetch(`${url}api/v1/stream`);
    const shutdownReader = shutdownResponse.body.getReader();
    await shutdownReader.read();
    await server.stop();
    assert.equal((await shutdownReader.read()).done, true);
    assert.equal(runtime.subscribers.length, 0);
  } finally {
    await server.stop();
  }
});

test("SSE backpressure drops subsequent updates and emits one resync gap after drain", () => {
  class FakeResponse extends EventEmitter {
    writes = [];
    first = true;
    write(value) { this.writes.push(value); if (this.first) { this.first = false; return false; } return true; }
    end() {}
  }
  const response = new FakeResponse();
  const broker = new SseBroker();
  broker.add(response, { status: "initial" });
  for (let index = 0; index < 100; index += 1) broker.broadcast("live-event", { index });
  assert.equal(response.writes.length, 1);
  response.emit("drain");
  assert.equal(response.writes.length, 2);
  assert.match(response.writes[1], /event: stream-gap/);
  assert.match(response.writes[1], /"dropped":100/);
  response.emit("close");
  assert.equal(broker.clientCount, 0);
});

test("serves a CSP-protected dependency-free dashboard without unsafe innerHTML rendering", async () => {
  const { server, url } = await fixture();
  try {
    const page = await fetch(url);
    const html = await page.text();
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(html, /https?:\/\//);
    const script = await (await fetch(`${url}app.js`)).text();
    assert.doesNotMatch(script, /innerHTML/);
    assert.match(script, /textContent/);
  } finally {
    await server.stop();
  }
});
