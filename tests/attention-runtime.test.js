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

function aiConfig({ speech = "off", maxBatchMessages = 20 } = {}) {
  const config = loadConfig({
    LIVE_ASSISTANT_ATTENTION_MODE: "ai",
    LIVE_ASSISTANT_SPEECH_ENGINE: speech,
  });
  config.attention.ai.maxBatchMessages = maxBatchMessages;
  return config;
}

class SyntheticAiProvider {
  calls = [];
  closed = false;
  constructor(analyze) { this.analyze = analyze; }
  async analyzeBatch(batch, options) { this.calls.push(batch); return this.analyze(batch, options); }
  getStatus() { return { name: "fake", model: "synthetic-fixture", state: this.closed ? "unavailable" : "healthy", lastLatencyMs: 0 }; }
  async close() { this.closed = true; }
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

test("finite simulator flushes a partial AI batch, waits for semantic decisions, and works with speech off", async () => {
  const provider = new SyntheticAiProvider(async (batch) => ({
    groups: [
      { itemIds: batch.items.slice(0, 3).map(({ itemId }) => itemId), classification: "question", importance: 85, reason: "semantic_question_group", summary: "What weapon are you using?" },
      { itemIds: batch.items.slice(3, 5).map(({ itemId }) => itemId), classification: "question", importance: 78, reason: "semantic_question_group", summary: "Where did you find the chest?" },
      { itemIds: [batch.items[5].itemId], classification: "message", importance: 45, reason: "useful_message", summary: "Nice dodge" },
      { itemIds: [batch.items[6].itemId], classification: "low_information", importance: 5, reason: "low_information", summary: "Excited reaction" },
    ],
  }));
  const runtime = new LiveAssistantRuntime({
    config: aiConfig(),
    connector: new SimulatorConnector({ scenario: "attention-semantic-burst" }),
    speechEngineType: "off",
    speechEngine: null,
    attentionMode: "ai",
    aiProvider: provider,
  });
  runtime.start();
  const result = await runtime.waitForCompletion();
  assert.equal(result.connector.status, "completed");
  assert.equal(provider.calls.length, 1);
  const decisions = runtime.getRecentAttention({ limit: 10 });
  assert.equal(decisions.length, 4);
  assert.deepEqual(decisions.slice(0, 2).map(({ group }) => [group.kind, group.occurrences]), [["semantic", 3], ["semantic", 2]]);
  assert.equal(decisions[0].displayText, "3 viewers asked: What weapon are you using?");
  assert.equal(decisions.every(({ strategy }) => strategy === "ai"), true);
  assert.equal(decisions[0].speech.actionResult.reason, "speech_off");
  assert.equal(runtime.getStatus().speech.queueSize, 0);
  assert.equal(runtime.getStatus().attention.provider.model, "synthetic-fixture");
  await runtime.stop();
});

test("AI response arriving after pause remains visible but is never replayed after resume", async () => {
  const connector = new ManualConnector();
  let release;
  let providerCall = 0;
  const provider = new SyntheticAiProvider(async (batch) => {
    providerCall += 1;
    if (providerCall === 1) await new Promise((resolve) => { release = resolve; });
    return { groups: [{ itemIds: [batch.items[0].itemId], classification: "question", importance: 80, reason: "semantic_question_group", summary: "Which weapon?" }] };
  });
  const spoken = [];
  const runtime = new LiveAssistantRuntime({
    config: aiConfig({ speech: "windows", maxBatchMessages: 1 }), connector,
    speechEngineType: "windows", speechEngine: { async speak(text) { spoken.push(text); }, async close() {} },
    attentionMode: "ai", aiProvider: provider, drainSpeechOnConnectorCompletion: false,
  });
  runtime.start();
  connector.push(chat("ai-paused", "Which weapon?", 0, "u1"));
  await until(() => runtime.getStatus().attention.provider.inFlight === 1);
  runtime.pauseSpeech();
  runtime.resumeSpeech();
  release();
  await until(() => runtime.getStatus().attention.decisionHistorySize === 1);
  assert.equal(spoken.length, 0);
  assert.equal(runtime.getRecentAttention({ limit: 1 })[0].speech.actionResult.reason, "speech_paused");

  connector.push(chat("ai-future", "Which route?", 1, "u2"));
  await until(() => spoken.length === 1);
  assert.equal(spoken[0], "Which weapon?");
  await runtime.stop();
});

test("runtime shutdown aborts active AI analysis without a late attention event", async () => {
  const connector = new ManualConnector();
  let aborted = false;
  const provider = new SyntheticAiProvider(async (_batch, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
  }));
  const runtime = new LiveAssistantRuntime({
    config: aiConfig({ maxBatchMessages: 1 }), connector,
    speechEngineType: "off", speechEngine: null,
    attentionMode: "ai", aiProvider: provider, drainSpeechOnConnectorCompletion: false,
  });
  let attentionEvents = 0;
  runtime.subscribe(({ type }) => { if (type === "attention-decision") attentionEvents += 1; });
  runtime.start();
  connector.push(chat("shutdown", "Will this finish?", 0, "u1"));
  await until(() => runtime.getStatus().attention.provider.inFlight === 1);
  await runtime.stop();
  assert.equal(aborted, true);
  assert.equal(attentionEvents, 0);
  assert.equal(runtime.getRecentAttention().length, 0);
});

test("AI promotion still passes through final speech safety filters", async () => {
  const provider = new SyntheticAiProvider(async (batch) => ({
    groups: [{ itemIds: batch.items.map(({ itemId }) => itemId), classification: "message", importance: 90, reason: "useful_message", summary: "Visit https://unsafe.example now" }],
  }));
  const spoken = [];
  const runtime = new LiveAssistantRuntime({
    config: aiConfig({ speech: "windows" }),
    connector: new SimulatorConnector({ scenario: "quiet-chat" }),
    speechEngineType: "windows",
    speechEngine: { async speak(text) { spoken.push(text); }, async close() {} },
    attentionMode: "ai",
    aiProvider: provider,
  });
  runtime.start();
  await runtime.waitForCompletion();
  const semanticDecision = runtime.getRecentAttention().find(({ group }) => group?.kind === "semantic");
  assert.equal(semanticDecision.action, "promote");
  assert.equal(semanticDecision.speech.decision.reason, "url_not_allowed");
  assert.equal(spoken.length, 0);
  await runtime.stop();
});
