import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicEventFilter, normalizeSimulatorPayload } from "../src/index.js";

function chat(id, text) {
  return normalizeSimulatorPayload(
    { id, kind: "comment", timestamp: "2026-01-01T00:00:00Z", text },
    { clock: () => new Date("2026-01-01T00:00:00Z") },
  );
}

function createFilter(overrides = {}) {
  return new DeterministicEventFilter({
    duplicateWindowMs: 5_000,
    maxTrackedMessages: 2,
    suppressEmptyChat: true,
    ...overrides,
  });
}

test("suppresses normalized duplicate chat within the configured window", () => {
  const filter = createFilter();
  assert.equal(filter.evaluate(chat("a", "What weapon?"), 1_000).action, "emit");
  assert.deepEqual(filter.evaluate(chat("b", "  what   weapon? "), 2_000), {
    action: "suppress",
    reason: "duplicate_chat",
  });
  assert.equal(filter.evaluate(chat("c", "What weapon?"), 7_001).action, "emit");
});

test("suppresses empty chat and bounds duplicate tracking", () => {
  const filter = createFilter();
  assert.equal(filter.evaluate(chat("empty", "   "), 1).reason, "empty_chat");
  filter.evaluate(chat("a", "one"), 2);
  filter.evaluate(chat("b", "two"), 3);
  filter.evaluate(chat("c", "three"), 4);
  assert.equal(filter.trackedMessageCount, 2);
});

