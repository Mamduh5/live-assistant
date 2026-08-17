import test from "node:test";
import assert from "node:assert/strict";
import {
  AiAttentionBatcher,
  AiProviderError,
  AttentionEngine,
  DEFAULT_CONFIG,
  LiveEventType,
  createLiveEvent,
} from "../src/index.js";

function attentionConfig(ai = {}, scoring = {}) {
  return {
    ...DEFAULT_CONFIG.attention,
    mode: "ai",
    scoring: { ...DEFAULT_CONFIG.attention.scoring, ...scoring },
    ai: {
      ...DEFAULT_CONFIG.attention.ai,
      ...ai,
      openai: { ...DEFAULT_CONFIG.attention.ai.openai, ...(ai.openai ?? {}) },
    },
  };
}

function chat(id, text, { receivedAt = 0, user, raw = { private: true } } = {}) {
  return createLiveEvent({
    id, type: LiveEventType.CHAT_MESSAGE, platform: "simulated", connector: "test",
    timestamp: receivedAt, receivedAt, ...(user ? { user } : {}), data: { text }, raw,
  });
}

class Scheduler {
  now = 0;
  sequence = 0;
  tasks = new Map();
  setTimeout = (handler, delay) => {
    const id = ++this.sequence;
    this.tasks.set(id, { handler, at: this.now + delay });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].handler();
    }
    this.now = target;
  }
}

class FakeProvider {
  constructor(analyze) { this.analyze = analyze; }
  calls = [];
  active = 0;
  maxActive = 0;
  closed = false;
  async analyzeBatch(batch, options) {
    this.calls.push(structuredClone(batch));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try { return await this.analyze(batch, options); } finally { this.active -= 1; }
  }
  getStatus() {
    return { name: "fake", model: "synthetic-fixture", state: this.closed ? "unavailable" : "healthy", requests: this.calls.length, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, lastLatencyMs: 0 };
  }
  async close() { this.closed = true; }
}

function semanticGroup(batch, overrides = {}) {
  return {
    groups: [{
      itemIds: batch.items.map(({ itemId }) => itemId),
      classification: "question",
      importance: 80,
      reason: "semantic_question_group",
      summary: "What weapon are you using?",
      ...overrides,
    }],
  };
}

function aiEngine({ provider, scheduler = new Scheduler(), config = attentionConfig(), diagnostics = [] } = {}) {
  let id = 0;
  return {
    scheduler,
    diagnostics,
    engine: new AttentionEngine({
      config, mode: "ai", aiProvider: provider, clock: () => scheduler.now,
      setTimeoutFn: scheduler.setTimeout, clearTimeoutFn: scheduler.clearTimeout,
      onDiagnostic: (value) => diagnostics.push(value),
      policyDependencies: { idFactory: () => `decision-${++id}` },
      failureIdFactory: () => `ai-decision-${++id}`,
    }),
  };
}

test("AI mode ingests synchronously, semantically groups through a fake provider, and computes local counts", async () => {
  const provider = new FakeProvider(async (batch) => semanticGroup(batch));
  const { engine } = aiEngine({ provider });
  const observed = [];
  engine.subscribe((decision) => observed.push(decision));
  const privateUser = { id: "provider-user-id", username: "private-name", displayName: "Private Name", avatarUrl: "https://private/avatar" };

  assert.equal(engine.observe(chat("e1", "What weapon are you using?", { user: privateUser, raw: { token: "raw-secret" } })), null);
  assert.equal(engine.observe(chat("e2", "Which sword is that?", { user: { id: "u2" } })), null);
  assert.equal(engine.observe(chat("e3", "What are you fighting with?", { user: { id: "u3" } })), null);
  assert.equal(observed.length, 0);
  await engine.flush();

  assert.equal(provider.calls.length, 1);
  const serialized = JSON.stringify(provider.calls[0]);
  assert.equal(serialized.includes("raw-secret"), false);
  assert.equal(serialized.includes("private-name"), false);
  assert.equal(serialized.includes("provider-user-id"), false);
  assert.equal(provider.calls[0].items.length, 3);
  assert.equal(observed.length, 1);
  const decision = observed[0];
  assert.equal(decision.strategy, "ai");
  assert.equal(decision.action, "promote");
  assert.equal(decision.priority, 80);
  assert.deepEqual(decision.score, { total: 80, threshold: 40, factors: [{ code: "ai_importance", value: 80 }] });
  assert.deepEqual(decision.sourceEventIds, ["e1", "e2", "e3"]);
  assert.equal(decision.group.kind, "semantic");
  assert.equal(decision.group.occurrences, 3);
  assert.equal(decision.group.uniqueUsers, 3);
  assert.equal(decision.candidate.text, "3 viewers asked: What weapon are you using?");
  assert.equal(decision.candidate.userId, undefined);
});

test("application thresholds, not the provider, determine AI promote versus ignore", async () => {
  const provider = new FakeProvider(async (batch) => ({
    groups: [
      { itemIds: [batch.items[0].itemId], classification: "question", importance: 80, reason: "semantic_question_group", summary: "Weapon question?" },
      { itemIds: [batch.items[1].itemId], classification: "message", importance: 55, reason: "useful_message", summary: "Useful comment" },
    ],
  }));
  const { engine } = aiEngine({ provider, config: attentionConfig({}, { quietThreshold: 60 }) });
  engine.observe(chat("q", "Which weapon?", { user: { id: "u1" } }));
  engine.observe(chat("m", "That route is safer", { user: { id: "u2" } }));
  await engine.flush();
  const decisions = engine.getRecentDecisions();
  assert.deepEqual(decisions.map(({ action }) => action), ["promote", "ignore"]);
  assert.deepEqual(decisions.map(({ score }) => score.threshold), [60, 60]);
  assert.equal(decisions[1].summary, "Useful comment");
  assert.equal(decisions[1].candidate, null);
});

test("invalid semantic mapping falls back visibly to existing deterministic attention", async () => {
  const diagnostics = [];
  const provider = new FakeProvider(async (batch) => ({
    groups: [{ itemIds: [batch.items[0].itemId], classification: "question", importance: 80, reason: "semantic_question_group", summary: "Only one item" }],
  }));
  const { engine } = aiEngine({ provider, diagnostics });
  engine.observe(chat("a", "First question?", { user: { id: "u1" } }));
  engine.observe(chat("b", "Second question?", { user: { id: "u2" } }));
  await engine.flush();
  const decisions = engine.getRecentDecisions();
  assert.equal(decisions.length, 2);
  assert.equal(decisions.every(({ strategy }) => strategy === "deterministic_fallback"), true);
  assert.equal(decisions.every(({ fallbackReason }) => fallbackReason === "provider_invalid_response"), true);
  assert.equal(diagnostics.some(({ code }) => code === "attention.ai.invalid_response"), true);
});

test("batching uses a first-item timer and exact duplicate pre-compression", async () => {
  const scheduler = new Scheduler();
  const provider = new FakeProvider(async (batch) => semanticGroup(batch));
  const results = [];
  const batcher = new AiAttentionBatcher({
    config: attentionConfig().ai, provider, clock: () => scheduler.now,
    setTimeoutFn: scheduler.setTimeout, clearTimeoutFn: scheduler.clearTimeout,
    onResult: (batch, result) => results.push({ batch, result }), onFallback: () => {},
  });
  batcher.observe(chat("a", "What weapon are you using?", { user: { id: "u1" } }), { classification: "question", speechEligible: true });
  batcher.observe(chat("b", " WHAT  WEAPON ARE YOU USING?? ", { user: { id: "u2" } }), { classification: "question", speechEligible: true });
  scheduler.advance(999);
  assert.equal(provider.calls.length, 0);
  scheduler.advance(1);
  await batcher.flush();
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0].items[0], {
    itemId: "item-1", text: "What weapon are you using?", occurrences: 2,
    knownUniqueViewers: 2, classificationHint: "question",
  });
  assert.equal(results[0].batch.items[0].sourceEventIds.length, 2);
  assert.equal(scheduler.tasks.size, 0);
});

test("batch item, character, and oversized-message limits are hard bounds", async () => {
  const makeBatcher = (overrides, provider, fallbacks = []) => new AiAttentionBatcher({
    config: attentionConfig(overrides).ai,
    provider,
    onResult: () => {},
    onFallback: (_batch, reason) => fallbacks.push(reason),
  });

  const itemProvider = new FakeProvider(async (batch) => semanticGroup(batch));
  const itemBatcher = makeBatcher({ maxBatchItems: 2, maxBatchMessages: 20, maxBatchChars: 100 }, itemProvider);
  for (const [id, text] of [["i1", "One?"], ["i2", "Two?"], ["i3", "Three?"]]) {
    itemBatcher.observe(chat(id, text), { classification: "question", speechEligible: true });
  }
  await itemBatcher.flush();
  assert.deepEqual(itemProvider.calls.map(({ items }) => items.length), [2, 1]);

  const charProvider = new FakeProvider(async (batch) => semanticGroup(batch));
  const charBatcher = makeBatcher({ maxBatchItems: 20, maxBatchMessages: 20, maxBatchChars: 8 }, charProvider);
  for (const [id, text] of [["c1", "1234"], ["c2", "5678"], ["c3", "x"]]) {
    charBatcher.observe(chat(id, text), { classification: "message", speechEligible: true });
  }
  await charBatcher.flush();
  assert.equal(charProvider.calls.length, 2);
  assert.equal(charProvider.calls.every(({ items }) => items.reduce((sum, item) => sum + item.text.length, 0) <= 8), true);

  const oversizedFallbacks = [];
  const oversizedProvider = new FakeProvider(async (batch) => semanticGroup(batch));
  const oversizedBatcher = makeBatcher({ maxBatchChars: 8 }, oversizedProvider, oversizedFallbacks);
  oversizedBatcher.observe(chat("large", "123456789"), { classification: "message", speechEligible: true });
  await oversizedBatcher.flush();
  assert.equal(oversizedProvider.calls.length, 0);
  assert.deepEqual(oversizedFallbacks, ["batch_item_too_large"]);
});

test("pending batches stay bounded, concurrency stays one, and overflow falls back oldest", async () => {
  let releaseFirst;
  let call = 0;
  const provider = new FakeProvider(async (batch) => {
    call += 1;
    if (call === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return semanticGroup(batch);
  });
  const fallbackIds = [];
  const batcher = new AiAttentionBatcher({
    config: attentionConfig({ maxBatchMessages: 1, maxPendingBatches: 3 }).ai,
    provider, onResult: () => {}, onFallback: (batch, reason) => fallbackIds.push([batch.id, reason]),
  });
  for (let index = 1; index <= 5; index += 1) {
    batcher.observe(chat(`e${index}`, `Question ${index}?`), { classification: "question", speechEligible: true });
  }
  assert.equal(provider.calls.length, 1);
  assert.equal(batcher.getStatus().pendingBatches, 3);
  assert.deepEqual(fallbackIds, [["batch-2", "batch_overflow"]]);
  releaseFirst();
  await batcher.flush();
  assert.equal(provider.maxActive, 1);
  assert.equal(provider.calls.length, 4);
});

test("rate budget and circuit breaker fallback without remote calls and recover after cooldown", async () => {
  const scheduler = new Scheduler();
  let failuresRemaining = 2;
  const provider = new FakeProvider(async (batch) => {
    if (failuresRemaining-- > 0) throw new AiProviderError("provider_network_error", "failed");
    return semanticGroup(batch);
  });
  const fallbacks = [];
  const config = attentionConfig({ maxBatchMessages: 1, requestsPerMinute: 10, failureThreshold: 2, circuitCooldownMs: 100 }).ai;
  const batcher = new AiAttentionBatcher({
    config, provider, clock: () => scheduler.now,
    setTimeoutFn: scheduler.setTimeout, clearTimeoutFn: scheduler.clearTimeout,
    onResult: () => {}, onFallback: (_batch, reason) => fallbacks.push(reason),
  });
  for (let index = 0; index < 3; index += 1) {
    batcher.observe(chat(`f${index}`, `Failure ${index}?`), { classification: "question", speechEligible: true });
    await batcher.flush();
  }
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(fallbacks, ["provider_network_error", "provider_network_error", "circuit_open"]);
  assert.equal(batcher.getStatus().state, "circuit_open");
  scheduler.advance(100);
  batcher.observe(chat("probe", "Recovered?"), { classification: "question", speechEligible: true });
  await batcher.flush();
  assert.equal(provider.calls.length, 3);
  assert.equal(batcher.getStatus().state, "healthy");

  const budgetFallbacks = [];
  const budgetProvider = new FakeProvider(async (batch) => semanticGroup(batch));
  const budgetBatcher = new AiAttentionBatcher({
    config: attentionConfig({ maxBatchMessages: 1, requestsPerMinute: 1 }).ai,
    provider: budgetProvider, clock: () => scheduler.now,
    onResult: () => {}, onFallback: (_batch, reason) => budgetFallbacks.push(reason),
  });
  budgetBatcher.observe(chat("r1", "First?"), { classification: "question", speechEligible: true });
  await budgetBatcher.flush();
  budgetBatcher.observe(chat("r2", "Second?"), { classification: "question", speechEligible: true });
  await budgetBatcher.flush();
  assert.equal(budgetProvider.calls.length, 1);
  assert.deepEqual(budgetFallbacks, ["rate_budget_exceeded"]);
  scheduler.advance(60_001);
  budgetBatcher.observe(chat("r3", "Third?"), { classification: "question", speechEligible: true });
  await budgetBatcher.flush();
  assert.equal(budgetProvider.calls.length, 2);
});

test("close aborts active analysis and emits neither a result nor fallback", async () => {
  let observedAbort = false;
  const provider = new FakeProvider(async (_batch, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(new AiProviderError("provider_aborted", "aborted"));
    });
  }));
  let emissions = 0;
  const batcher = new AiAttentionBatcher({
    config: attentionConfig({ maxBatchMessages: 1 }).ai, provider,
    onResult: () => { emissions += 1; }, onFallback: () => { emissions += 1; },
  });
  batcher.observe(chat("active", "Still active?"), { classification: "question", speechEligible: true });
  await batcher.close();
  assert.equal(observedAbort, true);
  assert.equal(emissions, 0);
});
