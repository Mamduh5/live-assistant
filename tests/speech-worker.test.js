import test from "node:test";
import assert from "node:assert/strict";
import { SpeechEngineError, SpeechQueue, SpeechWorker } from "../src/index.js";

function request(id) {
  return { id, eventId: `event-${id}`, text: `text-${id}`, priority: 50, createdAt: 1 };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for speech worker state");
}

test("waits for new work, preserves FIFO, and never overlaps calls", async () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  const calls = [];
  const gates = [];
  let active = 0;
  let maximumActive = 0;
  const engine = {
    speak(text) {
      calls.push(text);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const gate = deferred();
      gates.push(gate);
      return gate.promise.finally(() => { active -= 1; });
    },
    async close() {},
  };
  const worker = new SpeechWorker({ queue, engine });
  const running = worker.run();
  await until(() => queue.waitingConsumerCount === 1);
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  await until(() => calls.length === 1);
  assert.deepEqual(calls, ["text-a"]);
  gates[0].resolve();
  await until(() => calls.length === 2);
  gates[1].resolve();
  queue.close();
  const result = await running;
  assert.deepEqual(calls, ["text-a", "text-b"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(result, { status: "drained", completed: 2, failed: 0 });
});

test("gracefully drains queued requests after producer close", async () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  const calls = [];
  const engine = { async speak(text) { calls.push(text); }, async close() {} };
  const worker = new SpeechWorker({ queue, engine });
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  const running = worker.run();
  const result = await worker.drain();
  assert.equal(await running, result);
  assert.deepEqual(calls, ["text-a", "text-b"]);
  assert.equal(result.status, "drained");
});

test("immediate cancellation aborts current speech and discards backlog", async () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  let activeSignal;
  let calls = 0;
  const engine = {
    speak(_text, { signal }) {
      calls += 1;
      activeSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
    async close() {},
  };
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  const worker = new SpeechWorker({ queue, engine });
  worker.run();
  await until(() => activeSignal !== undefined);
  const result = await worker.cancel();
  assert.equal(activeSignal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(queue.size, 0);
  assert.equal(result.status, "cancelled");
});

test("isolates an ordinary engine failure and continues to later requests", async () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  const calls = [];
  const diagnostics = [];
  const engine = {
    async speak(text) {
      calls.push(text);
      if (text === "text-a") throw new SpeechEngineError("temporary failure", { code: "speech_engine.process_failed" });
    },
    async close() {},
  };
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  queue.close();
  const result = await new SpeechWorker({ queue, engine, onDiagnostic: (value) => diagnostics.push(value) }).run();
  assert.deepEqual(calls, ["text-a", "text-b"]);
  assert.deepEqual(result, { status: "drained", completed: 1, failed: 1 });
  assert.equal(diagnostics.some(({ code }) => code === "speech.failed"), true);
});

test("stops cleanly after a permanent engine failure", async () => {
  const queue = new SpeechQueue({ maxQueue: 4 });
  const engine = {
    async speak() {
      throw new SpeechEngineError("unsupported", { code: "speech_engine.unsupported_platform", permanent: true });
    },
    async close() {},
  };
  queue.enqueue(request("a"));
  queue.enqueue(request("b"));
  const result = await new SpeechWorker({ queue, engine }).run();
  assert.deepEqual(result, { status: "engine_unavailable", completed: 0, failed: 1 });
  assert.equal(queue.closed, true);
  assert.equal(queue.size, 0);
});
