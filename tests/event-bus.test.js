import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventBus, normalizeSimulatorPayload } from "../src/index.js";

function event(id) {
  return normalizeSimulatorPayload(
    { id, kind: "follow", timestamp: "2026-01-01T00:00:00Z" },
    { clock: () => new Date("2026-01-01T00:00:01Z") },
  );
}

test("dispatches events and subscribers in registration order", async () => {
  const bus = new LiveEventBus({ maxQueue: 10, historyLimit: 10 });
  const calls = [];
  bus.subscribe((value) => calls.push(`first:${value.id}`));
  bus.subscribe((value) => calls.push(`second:${value.id}`));

  bus.publish(event("a"));
  bus.publish(event("b"));
  await bus.flush();

  assert.deepEqual(calls, ["first:a", "second:a", "first:b", "second:b"]);
});

test("bounds its pending queue with an observable drop-oldest policy", async () => {
  const diagnostics = [];
  const delivered = [];
  const bus = new LiveEventBus({
    maxQueue: 2,
    historyLimit: 10,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  bus.subscribe((value) => delivered.push(value.id));

  bus.publish(event("a"));
  bus.publish(event("b"));
  bus.publish(event("c"));
  await bus.flush();

  assert.deepEqual(delivered, ["b", "c"]);
  assert.equal(diagnostics[0].code, "event_bus.queue_overflow");
  assert.equal(diagnostics[0].droppedEventId, "a");
});

test("bounds history and isolates subscriber failures", async () => {
  const diagnostics = [];
  const delivered = [];
  const bus = new LiveEventBus({
    maxQueue: 10,
    historyLimit: 2,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  bus.subscribe(() => { throw new Error("broken consumer"); });
  bus.subscribe((value) => delivered.push(value.id));

  bus.publish(event("a"));
  await bus.flush();
  bus.publish(event("b"));
  await bus.flush();
  bus.publish(event("c"));
  await bus.flush();

  assert.deepEqual(delivered, ["a", "b", "c"]);
  assert.deepEqual(bus.getHistory().map(({ id }) => id), ["b", "c"]);
  assert.equal(diagnostics.length, 3);
});

