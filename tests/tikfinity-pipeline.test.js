import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  DeterministicSpeechPolicy,
  EventHistory,
  LiveEventBus,
  LiveEventType,
  SpeechQueue,
  TikFinityConnector,
  normalizeTikFinityEnvelope,
  runConnector,
} from "../src/index.js";

class PipelineSocket {
  listeners = new Map();

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...handlers, handler]);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== handler));
  }

  emit(type, fields = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(fields);
  }

  close() {
    this.emit("close", { code: 1000, reason: "test complete", wasClean: true });
  }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for pipeline state");
}

test("routes TikFinity envelopes through existing history and speech consumers", async () => {
  let socket;
  const connector = new TikFinityConnector({
    ...DEFAULT_CONFIG.tikfinity,
    webSocketFactory() {
      socket = new PipelineSocket();
      return socket;
    },
  });
  const bus = new LiveEventBus({ maxQueue: 10 });
  const history = new EventHistory({ limit: 10 });
  const policy = new DeterministicSpeechPolicy(DEFAULT_CONFIG.speechPolicy, { idFactory: () => "speech-id" });
  const speechQueue = new SpeechQueue({ maxQueue: 10 });
  bus.subscribe((event) => history.record(event));
  bus.subscribe((event) => {
    const decision = policy.evaluate(event, { queuePressure: speechQueue.pressure });
    if (decision.action === "queue_speech") speechQueue.enqueue(decision.request);
  });
  let nextEventId = 0;

  const resultPromise = runConnector({
    connector,
    normalize: (raw) => normalizeTikFinityEnvelope(raw, {
      clock: () => 1_800_000_000_000,
      idFactory: () => `event-${++nextEventId}`,
    }),
    bus,
    logger: { info() {}, warn() {}, error() {} },
  });

  await until(() => socket !== undefined);
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ event: "chat", data: { comment: "hello" } }) });
  socket.emit("message", { data: JSON.stringify({ event: "futureEvent", data: { value: 1 } }) });
  await until(() => history.size === 2);
  await connector.close();
  const result = await resultPromise;

  assert.equal(result.status, "completed");
  assert.deepEqual(history.getEvents().map(({ type }) => type), [
    LiveEventType.CHAT_MESSAGE,
    LiveEventType.PLATFORM_UNKNOWN,
  ]);
  assert.equal(speechQueue.size, 1);
  assert.equal(speechQueue.dequeue().text, "hello");
});
