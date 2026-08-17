import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventType, normalizeRawSimulatorPayload } from "../src/index.js";

const clock = () => Date.parse("2026-01-02T03:04:05.000Z");
const idFactory = () => "local-id";

test("normalizes raw connector fields to the canonical v1 envelope", () => {
  const raw = {
    id: "upstream-id",
    kind: "comment",
    timestamp: "2026-01-01T00:00:00Z",
    platform: "tiktok",
    user: { id: "user-1", username: "ada", name: "Ada", isModerator: true },
    text: "hello",
  };

  const event = normalizeRawSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.id, "local-id");
  assert.equal(event.type, LiveEventType.CHAT_MESSAGE);
  assert.equal(event.connector, "raw-simulator");
  assert.equal(event.timestamp, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(event.receivedAt, clock());
  assert.deepEqual(event.user, { id: "user-1", username: "ada", displayName: "Ada", isModerator: true });
  assert.deepEqual(event.data, { text: "hello" });
  assert.equal(event.raw, raw);
});

test("preserves unsupported events as platform.unknown", () => {
  const raw = { kind: "new_provider_feature", payload: { value: 42 } };
  const event = normalizeRawSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(event.data.reason, "unsupported_event_type");
  assert.equal(event.data.nativeEventType, "new_provider_feature");
  assert.equal(event.raw, raw);
});

test("preserves malformed payloads instead of throwing", () => {
  const event = normalizeRawSimulatorPayload(null, { clock, idFactory });

  assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(event.data.reason, "malformed_payload");
  assert.equal(event.raw, null);
});

test("preserves recognized events with malformed data as unknown", () => {
  const raw = { kind: "comment", text: 42 };
  const event = normalizeRawSimulatorPayload(raw, { clock, idFactory });

  assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(event.data.reason, "malformed_event_data");
  assert.equal(event.data.nativeEventType, "comment");
});

test("normalizes gift semantics without aggregating streaks", () => {
  const raw = {
    kind: "gift",
    gift: {
      id: "rose",
      name: "Rose",
      quantity: 3,
      unitCoins: 1,
      totalCoins: 3,
      streak: { active: false, completed: true, repeatCount: 3 },
    },
  };
  const event = normalizeRawSimulatorPayload(raw, { clock, idFactory });
  assert.equal(event.type, LiveEventType.GIFT_RECEIVED);
  assert.deepEqual(event.data.streak, { active: false, completed: true, repeatCount: 3 });
});
