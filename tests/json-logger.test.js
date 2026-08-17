import test from "node:test";
import assert from "node:assert/strict";
import { createJsonLogger } from "../src/index.js";

test("protects structured log metadata from field collisions", () => {
  const lines = [];
  const logger = createJsonLogger(
    (line) => lines.push(line),
    () => new Date("2026-01-01T00:00:00Z"),
  );
  logger.info("actual.message", { timestamp: 123, level: "fake", message: "fake", value: 42 });
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    message: "actual.message",
    value: 42,
  });
});
