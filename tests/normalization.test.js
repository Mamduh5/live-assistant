import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventType, normalizeSimulatorPayload } from "../src/index.js";

const clock = () => new Date("2026-01-02T03:04:05.000Z");
const idFactory = () => "generated-id";

test("normalizes connector-specific chat fields to a canonical event", () => {
  const raw = {
    id: "upstream-id",
    kind: "comment",
    timestamp: "2026-01-01T00:00:00Z",
    platform: "tiktok",
    user: { id: "user-1", name: "Ada" },
    text: "hello",
  };

  const event = normalizeSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.type, LiveEventType.CHAT_MESSAGE);
  assert.deepEqual(event.actor, { id: "user-1", displayName: "Ada" });
  assert.deepEqual(event.data, { text: "hello" });
  assert.equal(event.raw, raw);
  assert.equal(event.receivedAt, "2026-01-02T03:04:05.000Z");
});

test("preserves unsupported events as canonical unknown events", () => {
  const raw = { kind: "new_provider_feature", payload: { value: 42 } };
  const event = normalizeSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.type, LiveEventType.UNKNOWN);
  assert.equal(event.data.reason, "unsupported_event_type");
  assert.equal(event.source.nativeEventType, "new_provider_feature");
  assert.equal(event.raw, raw);
});

test("preserves malformed payloads instead of throwing", () => {
  const event = normalizeSimulatorPayload(null, { clock, idFactory });

  assert.equal(event.type, LiveEventType.UNKNOWN);
  assert.equal(event.data.reason, "malformed_payload");
  assert.equal(event.raw, null);
});

test("preserves recognized events with malformed data as unknown", () => {
  const raw = { id: "bad-chat", kind: "comment", text: 42 };
  const event = normalizeSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.type, LiveEventType.UNKNOWN);
  assert.equal(event.data.reason, "malformed_event_data");
  assert.equal(event.source.nativeEventType, "comment");
  assert.equal(event.raw, raw);
});
