import test from "node:test";
import assert from "node:assert/strict";
import {
  AttentionEngine,
  AttentionClassification,
  DEFAULT_CONFIG,
  DeterministicAttentionPolicy,
  LiveEventType,
  classifyAttentionEvent,
  createLiveEvent,
  normalizeExactQuestion,
} from "../src/index.js";

function config(overrides = {}, scoring = {}) {
  return {
    ...DEFAULT_CONFIG.attention,
    ...overrides,
    scoring: { ...DEFAULT_CONFIG.attention.scoring, ...scoring },
  };
}

function event(id, text, { receivedAt = 0, user, type = LiveEventType.CHAT_MESSAGE } = {}) {
  return createLiveEvent({
    id,
    type,
    platform: "simulated",
    connector: "test",
    timestamp: receivedAt,
    receivedAt,
    ...(user ? { user } : {}),
    data: type === LiveEventType.CHAT_MESSAGE ? { text } : type === LiveEventType.ROOM_VIEWER_COUNT ? { count: 1 } : {},
    raw: { mustNotLeak: id },
  });
}

class Scheduler {
  now = 0;
  nextId = 1;
  tasks = new Map();

  setTimeout = (handler, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, { handler, deadline: this.now + delay });
    return id;
  };

  clearTimeout = (id) => { this.tasks.delete(id); };

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.deadline <= target)
        .sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].deadline;
      this.tasks.delete(due[0]);
      due[1].handler();
    }
    this.now = target;
  }
}

function engine({
  attentionConfig = config(),
  scheduler = new Scheduler(),
  diagnostics = [],
  ids = [],
  policy,
  failureIdFactory,
} = {}) {
  let nextId = 0;
  const subject = new AttentionEngine({
    config: attentionConfig,
    mode: attentionConfig.mode,
    clock: () => scheduler.now,
    setTimeoutFn: scheduler.setTimeout,
    clearTimeoutFn: scheduler.clearTimeout,
    onDiagnostic: (value) => diagnostics.push(value),
    policyDependencies: { idFactory: () => ids[nextId++] ?? `decision-${nextId}` },
    ...(policy ? { policy } : {}),
    ...(failureIdFactory ? { failureIdFactory } : {}),
  });
  return { subject, scheduler, diagnostics };
}

test("exact normalization is Unicode-stable but does not pretend semantic similarity", () => {
  assert.equal(normalizeExactQuestion("What weapon are you using?"), "what weapon are you using?");
  assert.equal(normalizeExactQuestion(" WHAT   WEAPON ARE YOU USING?? "), "what weapon are you using?");
  assert.equal(normalizeExactQuestion("Ｗｈａｔ weapon are you using？"), "what weapon are you using?");
  assert.notEqual(normalizeExactQuestion("What weapon are you using?"), normalizeExactQuestion("What sword are you using?"));
  assert.notEqual(normalizeExactQuestion("What weapon are you using?"), normalizeExactQuestion("What weapon do you have?"));
});

test("classification handles questions, messages, Unicode text, low-information symbols, and non-chat", () => {
  assert.equal(classifyAttentionEvent(event("q", "هل هذا صحيح؟")), AttentionClassification.QUESTION);
  assert.equal(classifyAttentionEvent(event("m", "สวัสดีทุกคน")), AttentionClassification.MESSAGE);
  assert.equal(classifyAttentionEvent(event("emoji", "😂🔥!!!")), AttentionClassification.LOW_INFORMATION);
  assert.equal(classifyAttentionEvent(event("non", "", { type: LiveEventType.SOCIAL_FOLLOW })), AttentionClassification.NON_CHAT);
});

test("groups only exact-normalized questions, counts unique viewers, and uses a fixed first-seen deadline", () => {
  const scheduler = new Scheduler();
  const { subject } = engine({ attentionConfig: config({ mode: "deterministic", groupWindowMs: 1_000 }), scheduler });
  const decisions = [];
  subject.subscribe((decision) => decisions.push(decision));

  subject.observe(event("a", "What weapon are you using?", { receivedAt: 0, user: { id: "u1" } }));
  scheduler.advance(800);
  subject.observe(event("b", " WHAT   WEAPON ARE YOU USING?? ", { receivedAt: 800, user: { id: "u2" } }));
  scheduler.advance(100);
  subject.observe(event("c", "what weapon are you using?", { receivedAt: 900, user: { id: "u3" } }));
  subject.observe(event("d", "What sword are you using?", { receivedAt: 900, user: { id: "u4" } }));
  scheduler.advance(100);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, "repeated_question");
  assert.equal(decisions[0].group.occurrences, 3);
  assert.equal(decisions[0].group.uniqueUsers, 3);
  assert.equal(decisions[0].group.deadline, 1_000);
  assert.equal(decisions[0].candidate.text, "3 viewers asked: What weapon are you using?");
  assert.deepEqual(decisions[0].score, {
    total: 85,
    threshold: 40,
    factors: [{ code: "question_base", value: 65 }, { code: "repeat_viewers", value: 20 }],
  });
  scheduler.advance(900);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].candidate.text, "What sword are you using?");
});

test("same-user repetition and unknown viewers increase occurrences without fabricating viewers", async () => {
  const { subject } = engine({ attentionConfig: config({ mode: "deterministic" }) });
  subject.observe(event("a", "Same question?", { user: { id: "u1" } }));
  subject.observe(event("b", "same question??", { user: { id: "u1" } }));
  subject.observe(event("c", "SAME QUESTION?"));
  subject.observe(event("d", "same question?"));
  const [decision] = await subject.flush();
  assert.equal(decision.group.occurrences, 4);
  assert.equal(decision.group.uniqueUsers, 1);
  assert.equal(decision.score.total, 65);
  assert.equal(decision.candidate.text, "Same question?");
  assert.equal(decision.candidate.userId, "u1");
});

test("traffic levels change deterministic thresholds and prune by time while remaining count-bounded", () => {
  const scheduler = new Scheduler();
  const { subject } = engine({
    attentionConfig: config({ mode: "deterministic", recentWindowMs: 100, maxRecentMessages: 3 }, {
      busyMessageCount: 2,
      veryBusyMessageCount: 3,
    }),
    scheduler,
  });
  const first = subject.observe(event("a", "normal message", { receivedAt: 0 }));
  scheduler.advance(10);
  const second = subject.observe(event("b", "another message", { receivedAt: 10 }));
  scheduler.advance(10);
  const third = subject.observe(event("c", "third message", { receivedAt: 20 }));
  subject.observe(event("d", "fourth message", { receivedAt: 20 }));

  assert.deepEqual([first.score.threshold, second.score.threshold, third.score.threshold], [40, 60, 75]);
  assert.deepEqual([first.action, second.action, third.action], ["promote", "ignore", "ignore"]);
  assert.equal(subject.getStatus().recentChatCount, 3);
  assert.equal(subject.getStatus().trafficLevel, "very_busy");
  scheduler.advance(101);
  assert.deepEqual(subject.getStatus(), {
    mode: "deterministic",
    trafficLevel: "quiet",
    recentChatCount: 0,
    pendingGroupCount: 0,
    decisionHistorySize: 4,
  });
});

test("low-information and non-chat decisions are visible but never promoted", () => {
  const { subject } = engine({ attentionConfig: config({ mode: "deterministic" }) });
  const noise = subject.observe(event("noise", "🔥🔥🔥"));
  const nonChat = subject.observe(event("follow", "", { type: LiveEventType.SOCIAL_FOLLOW }));
  assert.equal(noise.reason, "low_information");
  assert.equal(noise.score.total, 10);
  assert.equal(noise.candidate, null);
  assert.equal(nonChat.reason, "non_chat");
  assert.equal(nonChat.candidate, null);
});

test("repetition bonus is capped and priority remains within 0..100", async () => {
  const { subject } = engine({ attentionConfig: config({ mode: "deterministic" }, {
    questionBase: 95,
    repeatedQuestionBonusPerUser: 20,
    repeatedQuestionBonusCap: 25,
  }) });
  for (let index = 0; index < 5; index += 1) {
    subject.observe(event(`q${index}`, "Capped question?", { user: { id: `u${index}` } }));
  }
  const [decision] = await subject.flush();
  assert.deepEqual(decision.score.factors, [
    { code: "question_base", value: 95 },
    { code: "repeat_viewers", value: 25 },
  ]);
  assert.equal(decision.score.total, 100);
  assert.equal(decision.priority, 100);
});

test("pending groups and decision history enforce deterministic bounds", async () => {
  const diagnostics = [];
  const { subject } = engine({
    attentionConfig: config({ mode: "deterministic", maxPendingGroups: 1, decisionHistoryLimit: 2 }),
    diagnostics,
  });
  subject.observe(event("q1", "First question?"));
  subject.observe(event("q2", "Second question?"));
  assert.equal(subject.getStatus().pendingGroupCount, 1);
  assert.equal(diagnostics.some(({ code }) => code === "attention.group_overflow"), true);
  await subject.flush();
  subject.observe(event("m", "ordinary message"));
  assert.equal(subject.getRecentDecisions().length, 2);
  assert.equal(diagnostics.some(({ code }) => code === "attention.decision_dropped"), true);
});

test("question-group member state is bounded during a duplicate flood", async () => {
  const diagnostics = [];
  const { subject } = engine({
    attentionConfig: config({ mode: "deterministic", maxRecentMessages: 2 }),
    diagnostics,
  });
  subject.observe(event("q1", "Bound this?", { user: { id: "u1" } }));
  subject.observe(event("q2", "BOUND THIS??", { user: { id: "u2" } }));
  subject.observe(event("q3", "bound this?", { user: { id: "u3" } }));
  const [decision] = await subject.flush();

  assert.equal(decision.group.occurrences, 3);
  assert.equal(decision.group.uniqueUsers, 2);
  assert.deepEqual(decision.sourceEventIds, ["q1", "q2"]);
  assert.equal(diagnostics.some(({ code }) => code === "attention.group_member_overflow"), true);
});

test("flush emits pending groups immediately and close cancels timers without late emissions", async () => {
  const scheduler = new Scheduler();
  const { subject } = engine({ attentionConfig: config({ mode: "deterministic" }), scheduler });
  const decisions = [];
  subject.subscribe((decision) => decisions.push(decision));
  subject.observe(event("q", "Will this flush?"));
  assert.equal(scheduler.tasks.size, 1);
  await subject.flush();
  assert.equal(decisions.length, 1);
  subject.observe(event("later", "Will this be cancelled?"));
  await subject.close();
  assert.equal(scheduler.tasks.size, 0);
  scheduler.advance(10_000);
  assert.equal(decisions.length, 1);
  assert.equal(subject.observe(event("closed", "No emission?")), null);
});

test("passthrough mode promotes chat immediately with compatibility priority", () => {
  const { subject } = engine({ attentionConfig: config({ mode: "passthrough" }) });
  const decision = subject.observe(event("chat", "hello"));
  assert.equal(decision.action, "promote");
  assert.equal(decision.reason, "passthrough");
  assert.equal(decision.priority, 50);
  assert.equal(decision.score.factors[0].code, "passthrough_priority");
  assert.equal(subject.getStatus().pendingGroupCount, 0);
});

test("policy failures produce safe ignored decisions and do not stop later ingestion", async () => {
  const scheduler = new Scheduler();
  const diagnostics = [];
  let fail = true;
  const attentionConfig = config({ mode: "deterministic" });
  const ordinaryPolicy = new DeterministicAttentionPolicy(attentionConfig, {
    idFactory: () => "recovered-1",
  });
  const policy = {
    classify: (input) => ordinaryPolicy.classify(input),
    decide: (input) => {
      if (fail) throw new Error("policy exploded");
      return ordinaryPolicy.decide(input);
    },
  };
  const { subject } = engine({
    attentionConfig,
    scheduler,
    policy,
    diagnostics,
    failureIdFactory: () => "failure-1",
  });

  subject.observe(event("failed-question", "Will this fail?", { receivedAt: 0 }));
  const [failure] = await subject.flush();
  assert.equal(failure.action, "ignore");
  assert.equal(failure.reason, "policy_failed");
  assert.equal(failure.candidate, null);
  assert.equal(diagnostics[0].code, "attention.policy_failed");

  fail = false;
  subject.observe(event("later-question", "Does ingestion continue?", { receivedAt: 1 }));
  const [later] = await subject.flush();
  assert.equal(later.action, "promote");
});
