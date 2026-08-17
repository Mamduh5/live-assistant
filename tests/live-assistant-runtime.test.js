import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAssistantRuntime,
  LiveEventType,
  createLiveEvent,
  loadConfig,
} from "../src/index.js";

function until(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (predicate()) return resolve();
      if (++attempts > 100) return reject(new Error("Timed out waiting for runtime state"));
      setImmediate(check);
    };
    check();
  });
}

function chat(id, text = id) {
  return createLiveEvent({
    id,
    type: LiveEventType.CHAT_MESSAGE,
    platform: "simulated",
    connector: "test",
    timestamp: Date.now(),
    receivedAt: Date.now(),
    user: { id: `user-${id}`, displayName: `<img onerror=${id}>` },
    data: { text },
    raw: { private: id },
  });
}

class PushConnector {
  name = "test";
  state = "idle";
  #items = [];
  #waiters = [];
  #subscribers = [];

  subscribeState(handler) {
    this.#subscribers.push(handler);
    handler(this.state);
    return () => { this.#subscribers = this.#subscribers.filter((item) => item !== handler); };
  }

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#items.push(value);
  }

  async *events(signal) {
    this.#transition("connected");
    while (!signal.aborted) {
      const value = this.#items.length > 0
        ? this.#items.shift()
        : await new Promise((resolve) => {
          this.#waiters.push(resolve);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      if (value === null || signal.aborted) break;
      yield value;
    }
    this.#transition("disconnected");
  }

  async close() {
    for (const waiter of this.#waiters.splice(0)) waiter(null);
    this.#transition("disconnected");
  }

  #transition(state) {
    this.state = state;
    for (const handler of [...this.#subscribers]) handler(state);
  }
}

function runtimeWith({ connector = new PushConnector(), engine, includeRaw = false } = {}) {
  const config = loadConfig({ LIVE_ASSISTANT_SPEECH_ENGINE: engine ? "windows" : "off" });
  return new LiveAssistantRuntime({
    config,
    connector,
    speechEngineType: engine ? "windows" : "off",
    speechEngine: engine ?? null,
    includeRaw,
    drainSpeechOnConnectorCompletion: false,
  });
}

test("runtime starts, projects connector state and sanitized bounded event history, and stops idempotently", async () => {
  const connector = new PushConnector();
  const runtime = runtimeWith({ connector });
  runtime.start();
  connector.push(chat("one", "<img src=x onerror=alert(1)>") );
  await until(() => runtime.getStatus().events.historySize === 1);
  const [event] = runtime.getRecentEvents({ limit: 999 });
  assert.equal(runtime.getStatus().connector.state, "connected");
  assert.equal(event.summary, "<img src=x onerror=alert(1)>");
  assert.equal("raw" in event, false);
  await runtime.stop();
  await runtime.stop();
  assert.equal(runtime.getStatus().runtime.state, "stopped");
});

test("raw event projection follows only server-side runtime policy", async () => {
  const connector = new PushConnector();
  const runtime = runtimeWith({ connector, includeRaw: true });
  runtime.start();
  connector.push(chat("raw"));
  await until(() => runtime.getStatus().events.historySize === 1);
  assert.deepEqual(runtime.getRecentEvents({ limit: 1 })[0].raw, { private: "raw" });
  await runtime.stop();
});

test("an ordinary connector failure remains an operational result while the runtime stays available", async () => {
  const connector = {
    name: "failing",
    async *events() { throw new Error("adapter offline"); },
    async close() {},
  };
  const runtime = runtimeWith({ connector });
  runtime.start();
  const result = await runtime.waitForCompletion();
  assert.equal(result.connector.status, "failed");
  assert.equal(runtime.getStatus().runtime.state, "running");
  await runtime.stop();
});

test("status removes credentials, path, and query values from connector endpoints", async () => {
  const config = loadConfig({ LIVE_ASSISTANT_TIKFINITY_URL: "ws://user:secret@127.0.0.1:21213/private?token=value" });
  const connector = new PushConnector();
  connector.name = "tikfinity";
  const runtime = new LiveAssistantRuntime({
    config,
    connector,
    speechEngine: null,
    drainSpeechOnConnectorCompletion: false,
  });
  assert.equal(runtime.getStatus().connector.endpoint, "ws://127.0.0.1:21213/");
  assert.doesNotMatch(JSON.stringify(runtime.getStatus()), /secret|private|token|value/);
  await runtime.stop();
});

test("pause rejects new speech, resume affects future events, clear preserves current, and cancel-current remains reusable", async () => {
  const connector = new PushConnector();
  const calls = [];
  const signals = [];
  const engine = {
    speak(text, { signal }) {
      calls.push(text);
      signals.push(signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
    async close() {},
  };
  const runtime = runtimeWith({ connector, engine });
  runtime.start();
  runtime.pauseSpeech();
  connector.push(chat("paused"));
  await until(() => runtime.getStatus().events.historySize === 1);
  assert.equal(calls.length, 0);

  runtime.resumeSpeech();
  connector.push(chat("active"));
  connector.push(chat("queued-a"));
  connector.push(chat("queued-b"));
  await until(() => calls.length === 1 && runtime.getStatus().speech.queueSize === 2);
  assert.deepEqual(runtime.clearSpeechQueue(), { cleared: 2, queueSize: 0 });
  assert.equal(runtime.cancelCurrentSpeech().cancelled, true);
  await until(() => runtime.getStatus().speech.currentRequestId === null);
  connector.push(chat("future"));
  await until(() => calls.length === 2);
  assert.equal(signals[0].aborted, true);
  await runtime.stop();
});
