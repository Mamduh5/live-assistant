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

test("loads validated TikFinity endpoint and reconnect overrides", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_TIKFINITY_URL: "ws://127.0.0.1:3000/events",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS: "25",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS: "500",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER: "1.5",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO: "0.1",
  });
  assert.equal(config.tikfinity.url, "ws://127.0.0.1:3000/events");
  assert.deepEqual(config.tikfinity.reconnect, {
    initialDelayMs: 25,
    maxDelayMs: 500,
    multiplier: 1.5,
    jitterRatio: 0.1,
  });
});

test("falls back safely for invalid TikFinity configuration", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_TIKFINITY_URL: "https://public.example.invalid",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS: "20000",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS: "100",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO: "2",
  }, (value) => diagnostics.push(value));
  assert.deepEqual(config.tikfinity, DEFAULT_CONFIG.tikfinity);
  assert.equal(diagnostics.length, 3);
});
