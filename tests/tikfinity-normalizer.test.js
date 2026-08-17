import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LiveEventType, normalizeTikFinityEnvelope } from "../src/index.js";

const fixtures = JSON.parse(await readFile(
  new URL("./fixtures/tikfinity/synthetic-events.json", import.meta.url),
  "utf8",
));
const receivedAt = Date.parse("2026-02-03T04:05:06.000Z");
const options = { clock: () => receivedAt, idFactory: () => "local-tikfinity-id" };

test("normalizes TikFinity chat with canonical identity, user, timestamps, and complete raw envelope", () => {
  const event = normalizeTikFinityEnvelope(fixtures.chat, options);
  assert.equal(event.id, "local-tikfinity-id");
  assert.equal(event.type, LiveEventType.CHAT_MESSAGE);
  assert.equal(event.platform, "tiktok");
  assert.equal(event.connector, "tikfinity");
  assert.equal(event.timestamp, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(event.receivedAt, receivedAt);
  assert.deepEqual(event.user, {
    id: "synthetic-user-1",
    username: "synthetic_viewer",
    displayName: "Synthetic Viewer",
    avatarUrl: "https://example.invalid/synthetic-avatar.png",
    isFollower: true,
    isSubscriber: false,
    isModerator: false,
  });
  assert.deepEqual(event.data, { text: "Synthetic hello" });
  assert.equal(event.raw, fixtures.chat);
});

test("maps every supported TikFinity event name", () => {
  const cases = [
    ["giftOneOff", LiveEventType.GIFT_RECEIVED],
    ["share", LiveEventType.SOCIAL_SHARE],
    ["follow", LiveEventType.SOCIAL_FOLLOW],
    ["like", LiveEventType.ENGAGEMENT_LIKE],
    ["roomUser", LiveEventType.ROOM_VIEWER_COUNT],
    ["subscribe", LiveEventType.SUBSCRIPTION_STARTED],
  ];
  for (const [fixtureName, expectedType] of cases) {
    assert.equal(normalizeTikFinityEnvelope(fixtures[fixtureName], options).type, expectedType);
  }
  assert.deepEqual(normalizeTikFinityEnvelope(fixtures.like, options).data, { count: 7 });
  assert.deepEqual(normalizeTikFinityEnvelope(fixtures.roomUser, options).data, { count: 321 });
  assert.deepEqual(normalizeTikFinityEnvelope(fixtures.follow, options).data, {});
});

test("normalizes a one-off gift without inventing an active streak", () => {
  const event = normalizeTikFinityEnvelope(fixtures.giftOneOff, options);
  assert.deepEqual(event.data, {
    giftId: "1001",
    giftName: "Synthetic Rose",
    quantity: 1,
    unitCoins: 1,
  });
  assert.equal(event.data.streak, undefined);
});

test("normalizes intermediate and completed gift streak updates without aggregation", () => {
  const update = normalizeTikFinityEnvelope(fixtures.giftStreakUpdate, options);
  const completion = normalizeTikFinityEnvelope(fixtures.giftStreakCompletion, options);
  assert.deepEqual(update.data.streak, { active: true, completed: false, repeatCount: 3 });
  assert.deepEqual(completion.data.streak, { active: false, completed: true, repeatCount: 5 });
});

test("preserves invalid repeat data as a malformed unknown event", () => {
  const event = normalizeTikFinityEnvelope(fixtures.malformedGift, options);
  assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(event.data.reason, "malformed_event_data");
  assert.equal(event.data.nativeEventType, "gift");
  assert.equal(event.raw, fixtures.malformedGift);
});

test("preserves unsupported native event names as platform.unknown", () => {
  const event = normalizeTikFinityEnvelope(fixtures.unknown, options);
  assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(event.data.reason, "unsupported_event_type");
  assert.equal(event.data.nativeEventType, "syntheticFutureEvent");
  assert.equal(event.platform, "tiktok");
  assert.equal(event.connector, "tikfinity");
});

test("turns recognized malformed data into unknown without throwing", () => {
  const malformedChat = normalizeTikFinityEnvelope(fixtures.malformedChat, options);
  const missingData = normalizeTikFinityEnvelope({ event: "chat" }, options);
  assert.equal(malformedChat.type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(malformedChat.data.reason, "malformed_event_data");
  assert.equal(missingData.data.reason, "malformed_event_data");
});

test("allows supported events without a user and ignores invalid optional user fields", () => {
  const withoutUser = normalizeTikFinityEnvelope({ event: "follow", data: {} }, options);
  const invalidUser = normalizeTikFinityEnvelope({
    event: "share",
    data: { userId: {}, nickname: 42, isModerator: "yes" },
  }, options);
  assert.equal(withoutUser.user, undefined);
  assert.equal(invalidUser.user, undefined);
});

test("uses only explicit millisecond or parseable string source timestamps", () => {
  const milliseconds = normalizeTikFinityEnvelope({
    event: "follow",
    data: { timestamp: 1_767_268_800_000 },
  }, options);
  const ambiguousSeconds = normalizeTikFinityEnvelope({
    event: "follow",
    data: { timestamp: 1_767_268_800 },
  }, options);
  assert.equal(milliseconds.timestamp, 1_767_268_800_000);
  assert.equal(ambiguousSeconds.timestamp, receivedAt);
});

test("handles malformed envelopes defensively", () => {
  for (const raw of [null, [], "text", {}, { event: 42 }, { event: "   " }]) {
    const event = normalizeTikFinityEnvelope(raw, options);
    assert.equal(event.type, LiveEventType.PLATFORM_UNKNOWN);
    assert.equal(event.data.reason, "malformed_payload");
    assert.equal(event.raw, raw);
  }
});
