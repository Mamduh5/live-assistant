import test from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue } from "../src/index.js";

function request(id) {
  return { id, eventId: `event-${id}`, text: id, priority: 50, createdAt: 1 };
}

test("is FIFO, bounded, and exposes queue pressure", () => {
  const diagnostics = [];
  const queue = new SpeechQueue({ maxQueue: 2, onDiagnostic: (value) => diagnostics.push(value) });
  assert.deepEqual(queue.enqueue(request("a")), { accepted: true, position: 0 });
  assert.equal(queue.pressure, 0.5);
  queue.enqueue(request("b"));
  assert.deepEqual(queue.enqueue(request("c")), { accepted: false, reason: "queue_full" });
  assert.equal(diagnostics[0].code, "speech_queue.full");
  assert.equal(queue.dequeue().id, "a");
  assert.equal(queue.dequeue().id, "b");
  assert.equal(queue.dequeue(), null);
});

