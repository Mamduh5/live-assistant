import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/index.js";

test("loads valid bounded configuration overrides", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_EVENT_QUEUE_LIMIT: "12",
    LIVE_ASSISTANT_HISTORY_LIMIT: "42",
    LIVE_ASSISTANT_SPEECH_QUEUE_LIMIT: "8",
  });
  assert.equal(config.eventBus.maxQueue, 12);
  assert.equal(config.eventHistory.limit, 42);
  assert.equal(config.speechQueue.maxQueue, 8);
});

test("reports invalid configuration and uses a safe default", () => {
  const diagnostics = [];
  const config = loadConfig(
    { LIVE_ASSISTANT_EVENT_QUEUE_LIMIT: "unbounded" },
    (diagnostic) => diagnostics.push(diagnostic),
  );
  assert.equal(config.eventBus.maxQueue, DEFAULT_CONFIG.eventBus.maxQueue);
  assert.equal(diagnostics[0].code, "config.invalid");
});

test("enables explicit raw payload inspection", () => {
  const config = loadConfig({ LIVE_ASSISTANT_INSPECT_RAW: "true" });
  assert.equal(config.inspector.includeRaw, true);
});
