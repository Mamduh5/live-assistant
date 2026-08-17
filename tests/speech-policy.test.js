import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, DeterministicSpeechPolicy, LiveEventType, createLiveEvent } from "../src/index.js";

function chat(id, text, userId = id) {
  return createLiveEvent({
    id,
    type: LiveEventType.CHAT_MESSAGE,
    platform: "simulated",
    connector: "test",
    timestamp: 1,
    receivedAt: 1,
    user: { id: userId },
    data: { text },
    raw: {},
  });
}

function policy(overrides = {}) {
  return new DeterministicSpeechPolicy(
    { ...DEFAULT_CONFIG.speechPolicy, ...overrides },
    { idFactory: () => "speech-id" },
  );
}

test("creates a provider-independent speech request for allowed chat", () => {
  const decision = policy().evaluate(chat("event-id", "  hello   streamer "), { now: 100 });
  assert.equal(decision.action, "queue_speech");
  assert.deepEqual(decision.request, {
    id: "speech-id",
    eventId: "event-id",
    text: "hello streamer",
    priority: 50,
    createdAt: 100,
  });
});

test("suppresses duplicates and per-user cooldown deterministically", () => {
  const subject = policy();
  assert.equal(subject.evaluate(chat("a", "What weapon?", "u1"), { now: 1_000 }).action, "queue_speech");
  assert.equal(subject.evaluate(chat("b", " what   weapon? ", "u2"), { now: 2_000 }).reason, "duplicate_chat");
  assert.equal(subject.evaluate(chat("c", "Different question", "u1"), { now: 2_500 }).reason, "user_cooldown");
  assert.equal(subject.evaluate(chat("d", "Different question", "u1"), { now: 3_001 }).action, "queue_speech");
});

test("handles empty text, URLs, length, disabled users, and queue pressure", () => {
  const subject = policy({ maxMessageLength: 10, disabledUserIds: ["blocked"] });
  assert.equal(subject.evaluate(chat("a", "  ")).reason, "empty_chat");
  assert.equal(subject.evaluate(chat("b", "https://x.io")).reason, "url_not_allowed");
  assert.equal(subject.evaluate(chat("c", "longer than ten")).reason, "message_too_long");
  assert.equal(subject.evaluate(chat("d", "hello", "blocked")).reason, "disabled_user");
  assert.equal(subject.evaluate(chat("e", "hello"), { queuePressure: 0.9 }).reason, "queue_pressure");
});

test("respects configured disabled event types", () => {
  const subject = policy({ enabledEventTypes: [] });
  assert.equal(subject.evaluate(chat("a", "hello")).reason, "disabled_event_type");
});

function candidate(id, text, overrides = {}) {
  return {
    text,
    priority: 87,
    primaryEventId: id,
    sourceEventIds: [id],
    userId: `user-${id}`,
    createdAt: 1,
    speechEligible: true,
    ...overrides,
  };
}

test("candidate evaluation propagates attention priority and grouped source IDs", () => {
  const decision = policy().evaluateCandidate(candidate("a", "selected output", {
    sourceEventIds: ["a", "b", "c"],
    userId: undefined,
  }), { now: 100 });
  assert.equal(decision.request.priority, 87);
  assert.deepEqual(decision.request.sourceEventIds, ["a", "b", "c"]);
  assert.equal(decision.request.eventId, "a");
});

test("attention promotion cannot bypass final URL, length, duplicate, cooldown, or queue-pressure filters", () => {
  const subject = policy({ maxMessageLength: 20 });
  assert.equal(subject.evaluateCandidate(candidate("url", "https://example.test")).reason, "url_not_allowed");
  assert.equal(subject.evaluateCandidate(candidate("long", "this is longer than twenty characters")).reason, "message_too_long");
  assert.equal(subject.evaluateCandidate(candidate("first", "duplicate", { userId: "u1" }), { now: 1_000 }).action, "queue_speech");
  assert.equal(subject.evaluateCandidate(candidate("duplicate", " DUPLICATE ", { userId: "u2" }), { now: 1_001 }).reason, "duplicate_chat");
  assert.equal(subject.evaluateCandidate(candidate("cooldown", "different", { userId: "u1" }), { now: 1_001 }).reason, "user_cooldown");
  assert.equal(subject.evaluateCandidate(candidate("pressure", "queue full"), { now: 10_000, queuePressure: 0.9 }).reason, "queue_pressure");
});
