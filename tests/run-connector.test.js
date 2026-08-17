import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventBus, LiveEventType, runConnector } from "../src/index.js";

const logger = { info() {}, warn() {}, error() {} };

test("turns an unexpected normalizer failure into an unknown event", async () => {
  const connector = { name: "test", async *events() { yield { secretShape: true }; } };
  const bus = new LiveEventBus({ maxQueue: 10 });
  const delivered = [];
  bus.subscribe((event) => delivered.push(event));

  const result = await runConnector({
    connector,
    normalize() { throw new Error("bad payload"); },
    bus,
    logger,
    clock: () => 123,
    idFactory: () => "fallback-id",
  });

  assert.equal(result.status, "completed");
  assert.equal(delivered[0].type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(delivered[0].data.reason, "normalizer_failed");
  assert.equal(delivered[0].receivedAt, 123);
});

test("reports connector failure as an operational result", async () => {
  const connector = { name: "test", async *events() { throw new Error("source unavailable"); } };
  const bus = new LiveEventBus({ maxQueue: 10 });
  const result = await runConnector({ connector, bus, logger });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /source unavailable/);
});
