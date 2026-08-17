import { randomUUID } from "node:crypto";
import { LiveEventType, createLiveEvent, createUnknownEvent } from "../events/live-event.js";

const TYPE_MAP = new Map([
  ["chat", LiveEventType.CHAT_MESSAGE],
  ["gift", LiveEventType.GIFT_RECEIVED],
  ["share", LiveEventType.SOCIAL_SHARE],
  ["follow", LiveEventType.SOCIAL_FOLLOW],
  ["like", LiveEventType.ENGAGEMENT_LIKE],
  ["roomUser", LiveEventType.ROOM_VIEWER_COUNT],
  ["subscribe", LiveEventType.SUBSCRIPTION_STARTED],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalIdentifier(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sourceTimestamp(value, fallback) {
  if (Number.isSafeInteger(value) && value >= 1_000_000_000_000) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function extractUser(data) {
  const user = {
    ...(optionalIdentifier(data.userId) ? { id: optionalIdentifier(data.userId) } : {}),
    ...(optionalString(data.uniqueId) ? { username: data.uniqueId } : {}),
    ...(optionalString(data.nickname) ? { displayName: data.nickname } : {}),
    ...(optionalString(data.profilePictureUrl) ? { avatarUrl: data.profilePictureUrl } : {}),
    ...(typeof data.isFollower === "boolean" ? { isFollower: data.isFollower } : {}),
    ...(typeof data.isSubscriber === "boolean" ? { isSubscriber: data.isSubscriber } : {}),
    ...(typeof data.isModerator === "boolean" ? { isModerator: data.isModerator } : {}),
  };
  return Object.keys(user).length > 0 ? user : undefined;
}

function chatData(data) {
  return typeof data.comment === "string" ? { text: data.comment } : null;
}

function giftData(data) {
  if (data.repeatCount !== undefined && positiveInteger(data.repeatCount) === undefined) return null;
  if (data.repeatEnd !== undefined && typeof data.repeatEnd !== "boolean") return null;
  if (data.repeatEnd !== undefined && positiveInteger(data.repeatCount) === undefined) return null;

  const quantity = positiveInteger(data.repeatCount) ?? 1;
  const giftId = optionalIdentifier(data.giftId);
  const giftName = optionalString(data.giftName) ?? optionalString(data.name);
  const unitCoins = Number.isSafeInteger(data.diamondCount) && data.diamondCount >= 0
    ? data.diamondCount
    : undefined;
  const streak = typeof data.repeatEnd === "boolean"
    ? { active: !data.repeatEnd, completed: data.repeatEnd, repeatCount: quantity }
    : undefined;

  return {
    ...(giftId ? { giftId } : {}),
    ...(giftName ? { giftName } : {}),
    quantity,
    ...(unitCoins !== undefined ? { unitCoins } : {}),
    ...(streak ? { streak } : {}),
  };
}

function likeData(data) {
  const count = positiveInteger(data.likeCount ?? data.count);
  return count === undefined ? null : { count };
}

function viewerCountData(data) {
  const count = data.viewerCount ?? data.count;
  return Number.isSafeInteger(count) && count >= 0 ? { count } : null;
}

function canonicalData(type, data) {
  switch (type) {
    case LiveEventType.CHAT_MESSAGE:
      return chatData(data);
    case LiveEventType.GIFT_RECEIVED:
      return giftData(data);
    case LiveEventType.ENGAGEMENT_LIKE:
      return likeData(data);
    case LiveEventType.ROOM_VIEWER_COUNT:
      return viewerCountData(data);
    default:
      return {};
  }
}

export function normalizeTikFinityEnvelope(raw, {
  clock = Date.now,
  idFactory = randomUUID,
} = {}) {
  const receivedAt = clock();
  const id = idFactory();
  const validEnvelope = isRecord(raw) && typeof raw.event === "string" && raw.event.trim().length > 0;
  const nativeEventType = validEnvelope ? raw.event : undefined;
  const rawData = validEnvelope && isRecord(raw.data) ? raw.data : undefined;
  const timestamp = sourceTimestamp(rawData?.timestamp ?? (isRecord(raw) ? raw.timestamp : undefined), receivedAt);

  const unknown = (reason) => createUnknownEvent({
    id,
    platform: "tiktok",
    connector: "tikfinity",
    nativeEventType,
    timestamp,
    receivedAt,
    raw,
    reason,
  });

  if (!validEnvelope) return unknown("malformed_payload");
  const type = TYPE_MAP.get(nativeEventType);
  if (!type) return unknown("unsupported_event_type");
  if (!rawData) return unknown("malformed_event_data");

  const data = canonicalData(type, rawData);
  if (data === null) return unknown("malformed_event_data");
  const user = extractUser(rawData);

  return createLiveEvent({
    id,
    platform: "tiktok",
    connector: "tikfinity",
    type,
    timestamp,
    receivedAt,
    ...(user ? { user } : {}),
    data,
    raw,
  });
}
