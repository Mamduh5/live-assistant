import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveAssistantRuntime,
  LiveEventType,
  SimulatorConnector,
  createLiveEvent,
  loadConfig,
} from "../src/index.js";

function until(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (predicate()) return resolve();
      if (++attempts > 100) return reject(new Error("Timed out waiting for attention runtime"));
      setImmediate(check);
    };
    check();
  });
}

function deterministicConfig({ speech = "windows", groupWindowMs = 1_500 } = {}) {
  const config = loadConfig({
    LIVE_ASSISTANT_ATTENTION_MODE: "deterministic",
    LIVE_ASSISTANT_SPEECH_ENGINE: speech,
  });
  config.attention.groupWindowMs = groupWindowMs;
  return config;
}

test("finite simulator flushes exact question groups through candidate, speech policy, FIFO queue, and worker", async () => {
  const calls = [];
  const engine = { async speak(text, options) { calls.push({ text, request: options.request }); }, async close() {} };
  const runtime = new LiveAssistantRuntime({
    config: deterministicConfig(),
    connector: new SimulatorConnector({ scenario: "attention-question-burst" }),
    speechEngineType: "windows",
    speechEngine: engine,
    attentionMode: "deterministic",
  });
  runtime.start();
  const result = await runtime.waitForCompletion();

  assert.equal(result.connector.status, "completed");
  assert.deepEqual(calls.map(({ text }) => text), [
    "3 viewers asked: What weapon are you using?",
    "What sword are you using?",
  ]);
  assert.deepEqual(calls.map(({ request }) => request.priority), [85, 65]);
  assert.equal(calls[0].request.sourceEventIds.length, 3);
  const decisions = runtime.getRecentAttention({ limit: 10 });
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].group.uniqueUsers, 3);
  assert.equal(decisions[0].speech.actionResult.accepted, true);
  await runtime.stop();
});

test("deterministic attention remains observable with speech off and never fills the speech queue", async () => {
  const runtime = new LiveAssistantRuntime({
    config: deterministicConfig({ speech: "off" }),
    connector: new SimulatorConnector({ scenario: "attention-question-burst" }),
    speechEngineType: "off",
    speechEngine: null,
    attentionMode: "deterministic",
  });
  runtime.start();
  await runtime.waitForCompletion();
  assert.equal(runtime.getStatus().attention.decisionHistorySize, 2);
  assert.equal(runtime.getStatus().speech.queueSize, 0);
  assert.equal(runtime.getRecentAttention({ limit: 1 })[0].speech.actionResult.reason, "speech_off");
  await runtime.stop();
});

class ManualConnector {
  name = "manual";
  items = [];
  waiters = [];
  push(value) { const waiter = this.waiters.shift(); if (waiter) waiter(value); else this.items.push(value); }
  async *events(signal) {
    while (!signal.aborted) {
      const item = this.items.shift() ?? await new Promise((resolve) => {
        this.waiters.push(resolve);
        signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      if (!item || signal.aborted) break;
      yield item;
    }
  }
  async close() { for (const waiter of this.waiters.splice(0)) waiter(null); }
}

function chat(id, text, receivedAt, userId) {
  return createLiveEvent({
    id,
    type: LiveEventType.CHAT_MESSAGE,
    platform: "simulated",
    connector: "manual",
    timestamp: receivedAt,
    receivedAt,
    ...(userId ? { user: { id: userId } } : {}),
    data: { text },
    raw: {},
  });
}

test("attention observes paused chat but a group crossing pause cannot replay after resume", async () => {
  const connector = new ManualConnector();
  const calls = [];
  let timerHandler;
  const engine = { async speak(text) { calls.push(text); }, async close() {} };
  const runtime = new LiveAssistantRuntime({
    config: deterministicConfig({ groupWindowMs: 100 }),
    connector,
    speechEngineType: "windows",
    speechEngine: engine,
    attentionMode: "deterministic",
    drainSpeechOnConnectorCompletion: false,
    attentionDependencies: {
      clock: () => 0,
      setTimeoutFn(handler) { timerHandler = handler; return 1; },
      clearTimeoutFn() { timerHandler = undefined; },
    },
  });
  runtime.start();
  connector.push(chat("a", "Which weapon?", 0, "u1"));
  await until(() => runtime.getStatus().attention.pendingGroupCount === 1);
  runtime.pauseSpeech();
  connector.push(chat("b", " WHICH   WEAPON?? ", 1, "u2"));
  await until(() => runtime.getStatus().attention.recentChatCount === 2);
  runtime.resumeSpeech();
  timerHandler();
  await until(() => runtime.getStatus().attention.decisionHistorySize === 1);
  assert.equal(calls.length, 0);
  assert.equal(runtime.getRecentAttention({ limit: 1 })[0].speech.actionResult.reason, "speech_paused");

  connector.push(chat("future", "A future ordinary message", 2, "u3"));
  await until(() => calls.length === 1);
  assert.equal(calls[0], "A future ordinary message");
  await runtime.stop();
});
