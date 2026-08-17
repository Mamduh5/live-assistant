import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventBus, LiveEventType, createLiveEvent } from "../src/index.js";

function event(id, type = LiveEventType.SOCIAL_FOLLOW) {
  return createLiveEvent({
    id,
    platform: "simulated",
    connector: "test",
    type,
    timestamp: 1,
    receivedAt: 2,
    data: type === LiveEventType.CHAT_MESSAGE ? { text: "hello" } : {},
    raw: {},
  });
}

test("dispatches events and subscribers in registration order", async () => {
  const bus = new LiveEventBus({ maxQueue: 10 });
  const calls = [];
  bus.subscribe((value) => calls.push(`first:${value.id}`));
  bus.subscribe((value) => calls.push(`second:${value.id}`));
  bus.publish(event("a"));
  bus.publish(event("b"));
  await bus.flush();
  assert.deepEqual(calls, ["first:a", "second:a", "first:b", "second:b"]);
});

test("supports type subscriptions and unsubscribe", async () => {
  const bus = new LiveEventBus({ maxQueue: 10 });
  const calls = [];
  const unsubscribe = bus.subscribe(LiveEventType.CHAT_MESSAGE, (value) => calls.push(value.id));
  bus.publish(event("follow"));
  bus.publish(event("chat", LiveEventType.CHAT_MESSAGE));
  await bus.flush();
  unsubscribe();
  bus.publish(event("later", LiveEventType.CHAT_MESSAGE));
  await bus.flush();
  assert.deepEqual(calls, ["chat"]);
});

test("bounds its pending queue with an observable drop-oldest policy", async () => {
  const diagnostics = [];
  const delivered = [];
  const bus = new LiveEventBus({ maxQueue: 2, onDiagnostic: (value) => diagnostics.push(value) });
  bus.subscribe((value) => delivered.push(value.id));
  bus.publish(event("a"));
  bus.publish(event("b"));
  bus.publish(event("c"));
  await bus.flush();
  assert.deepEqual(delivered, ["b", "c"]);
  assert.equal(diagnostics[0].droppedEventId, "a");
});

test("isolates subscriber failures", async () => {
  const diagnostics = [];
  const delivered = [];
  const bus = new LiveEventBus({ maxQueue: 10, onDiagnostic: (value) => diagnostics.push(value) });
  bus.subscribe(() => { throw new Error("broken consumer"); });
  bus.subscribe((value) => delivered.push(value.id));
  bus.publish(event("a"));
  await bus.flush();
  assert.deepEqual(delivered, ["a"]);
  assert.equal(diagnostics[0].code, "event_bus.subscriber_failed");
});

