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

test("waits without polling and wakes when a request is enqueued", async () => {
  const queue = new SpeechQueue({ maxQueue: 2 });
  const waiting = queue.take();
  assert.equal(queue.waitingConsumerCount, 1);
  queue.enqueue(request("wake"));
  assert.equal((await waiting).id, "wake");
  assert.equal(queue.waitingConsumerCount, 0);
  assert.equal(queue.size, 0);
});

test("graceful close drains FIFO backlog and rejects new producers", async () => {
  const diagnostics = [];
  const queue = new SpeechQueue({ maxQueue: 3, onDiagnostic: (value) => diagnostics.push(value) });
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  queue.close();
  assert.equal((await queue.take()).id, "a");
  assert.equal((await queue.take()).id, "b");
  assert.equal(await queue.take(), null);
  assert.deepEqual(queue.enqueue(request("c")), { accepted: false, reason: "queue_closed" });
  assert.equal(diagnostics[0].code, "speech_queue.closed");
});

test("clear removes backlog without changing queue pressure semantics", () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  assert.equal(queue.pressure, 0.5);
  assert.equal(queue.clear(), 2);
  assert.equal(queue.pressure, 0);
});

test("abort removes a pending waiter and does not leak it", async () => {
  const queue = new SpeechQueue({ maxQueue: 2 });
  const controller = new AbortController();
  const waiting = queue.take(controller.signal);
  assert.equal(queue.waitingConsumerCount, 1);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(queue.waitingConsumerCount, 0);
});

test("close wakes every empty-queue waiter", async () => {
  const queue = new SpeechQueue({ maxQueue: 2 });
  const first = queue.take();
  const second = queue.take();
  queue.close();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(queue.waitingConsumerCount, 0);
});
