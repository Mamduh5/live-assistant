import { randomUUID } from "node:crypto";
import { LiveEventType, createLiveEvent, createUnknownEvent } from "../events/live-event.js";

const TYPE_MAP = new Map([
  ["comment", LiveEventType.CHAT_MESSAGE],
  ["gift", LiveEventType.GIFT_RECEIVED],
  ["follow", LiveEventType.SOCIAL_FOLLOW],
  ["subscription", LiveEventType.SUBSCRIPTION_STARTED],
  ["like", LiveEventType.ENGAGEMENT_LIKE],
  ["share", LiveEventType.SOCIAL_SHARE],
  ["viewer_count", LiveEventType.ROOM_VIEWER_COUNT],
]);

function sourceTimestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return fallback;
}

function canonicalUser(payload) {
  if (!payload.user || typeof payload.user !== "object") return undefined;
  const user = {
    ...(typeof payload.user.id === "string" ? { id: payload.user.id } : {}),
    ...(typeof payload.user.username === "string" ? { username: payload.user.username } : {}),
    ...(typeof payload.user.name === "string" ? { displayName: payload.user.name } : {}),
    ...(typeof payload.user.avatarUrl === "string" ? { avatarUrl: payload.user.avatarUrl } : {}),
    ...(typeof payload.user.isFollower === "boolean" ? { isFollower: payload.user.isFollower } : {}),
    ...(typeof payload.user.isSubscriber === "boolean" ? { isSubscriber: payload.user.isSubscriber } : {}),
    ...(typeof payload.user.isModerator === "boolean" ? { isModerator: payload.user.isModerator } : {}),
  };
  return Object.keys(user).length > 0 ? user : undefined;
}

function canonicalData(type, payload) {
  switch (type) {
    case LiveEventType.CHAT_MESSAGE:
      return typeof payload.text === "string" ? { text: payload.text } : null;
    case LiveEventType.GIFT_RECEIVED: {
      if (!payload.gift || typeof payload.gift !== "object") return null;
      const quantity = payload.gift.quantity ?? payload.gift.count ?? 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
      const streak = payload.gift.streak;
      if (streak !== undefined && (
        !streak ||
        typeof streak !== "object" ||
        typeof streak.active !== "boolean" ||
        typeof streak.completed !== "boolean" ||
        !Number.isSafeInteger(streak.repeatCount) ||
        streak.repeatCount < 1
      )) return null;
      return {
        ...(typeof payload.gift.id === "string" ? { giftId: payload.gift.id } : {}),
        ...(typeof payload.gift.name === "string" ? { giftName: payload.gift.name } : {}),
        quantity,
        ...(Number.isSafeInteger(payload.gift.unitCoins) ? { unitCoins: payload.gift.unitCoins } : {}),
        ...(Number.isSafeInteger(payload.gift.totalCoins) ? { totalCoins: payload.gift.totalCoins } : {}),
        ...(streak ? { streak: {
          active: streak.active,
          completed: streak.completed,
          repeatCount: streak.repeatCount,
        } } : {}),
      };
    }
    case LiveEventType.ENGAGEMENT_LIKE:
      if (payload.count !== undefined && (!Number.isSafeInteger(payload.count) || payload.count < 1)) return null;
      return { count: payload.count ?? 1 };
    case LiveEventType.ROOM_VIEWER_COUNT:
      return Number.isSafeInteger(payload.count) && payload.count >= 0 ? { count: payload.count } : null;
    default:
      return {};
  }
}

export function normalizeRawSimulatorPayload(raw, {
  clock = Date.now,
  idFactory = randomUUID,
} = {}) {
  const receivedAt = clock();
  const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const nativeEventType = isObject && typeof raw.kind === "string" ? raw.kind : undefined;
  const type = nativeEventType ? TYPE_MAP.get(nativeEventType) : undefined;
  const id = idFactory();
  const platform = isObject && typeof raw.platform === "string" && raw.platform.length > 0 ? raw.platform : "simulated";
  const timestamp = isObject ? sourceTimestamp(raw.timestamp, receivedAt) : receivedAt;

  if (!isObject || !type) {
    return createUnknownEvent({
      id,
      platform,
      connector: "raw-simulator",
      nativeEventType,
      timestamp,
      receivedAt,
      raw,
      reason: isObject ? "unsupported_event_type" : "malformed_payload",
    });
  }

  const data = canonicalData(type, raw);
  if (data === null) {
    return createUnknownEvent({
      id,
      platform,
      connector: "raw-simulator",
      nativeEventType,
      timestamp,
      receivedAt,
      raw,
      reason: "malformed_event_data",
    });
  }

  const user = canonicalUser(raw);
  return createLiveEvent({
    id,
    type,
    platform,
    connector: "raw-simulator",
    timestamp,
    receivedAt,
    ...(user ? { user } : {}),
    data,
    raw,
  });
}
