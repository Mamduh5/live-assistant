export const LIVE_EVENT_SCHEMA_VERSION = 1;

export const LiveEventType = Object.freeze({
  CHAT_MESSAGE: "chat.message",
  GIFT_RECEIVED: "gift.received",
  SOCIAL_FOLLOW: "social.follow",
  SOCIAL_SHARE: "social.share",
  ENGAGEMENT_LIKE: "engagement.like",
  SUBSCRIPTION_STARTED: "subscription.started",
  ROOM_VIEWER_COUNT: "room.viewer_count",
  PLATFORM_UNKNOWN: "platform.unknown",
});

const EVENT_TYPES = new Set(Object.values(LiveEventType));
const USER_STRING_FIELDS = ["id", "username", "displayName", "avatarUrl"];
const USER_BOOLEAN_FIELDS = ["isFollower", "isSubscriber", "isModerator"];

function assertUser(user) {
  if (user === undefined) return;
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new TypeError("LiveEvent.user must be an object");
  for (const field of USER_STRING_FIELDS) {
    if (user[field] !== undefined && typeof user[field] !== "string") throw new TypeError(`LiveEvent.user.${field} must be a string`);
  }
  for (const field of USER_BOOLEAN_FIELDS) {
    if (user[field] !== undefined && typeof user[field] !== "boolean") throw new TypeError(`LiveEvent.user.${field} must be a boolean`);
  }
}

function assertTypeData(type, data) {
  if (type === LiveEventType.CHAT_MESSAGE && typeof data.text !== "string") {
    throw new TypeError("chat.message data.text must be a string");
  }
  if (type === LiveEventType.GIFT_RECEIVED && (!Number.isSafeInteger(data.quantity) || data.quantity < 1)) {
    throw new TypeError("gift.received data.quantity must be a positive integer");
  }
  if (type === LiveEventType.ENGAGEMENT_LIKE && (!Number.isSafeInteger(data.count) || data.count < 1)) {
    throw new TypeError("engagement.like data.count must be a positive integer");
  }
  if (type === LiveEventType.ROOM_VIEWER_COUNT && (!Number.isSafeInteger(data.count) || data.count < 0)) {
    throw new TypeError("room.viewer_count data.count must be a non-negative integer");
  }
  if (type === LiveEventType.PLATFORM_UNKNOWN && typeof data.reason !== "string") {
    throw new TypeError("platform.unknown data.reason must be a string");
  }
}

export function assertLiveEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("LiveEvent must be an object");
  if (event.schemaVersion !== LIVE_EVENT_SCHEMA_VERSION) throw new TypeError("Unsupported LiveEvent schemaVersion");
  if (typeof event.id !== "string" || event.id.length === 0) throw new TypeError("LiveEvent.id must be a non-empty string");
  if (!EVENT_TYPES.has(event.type)) throw new TypeError(`Unsupported LiveEvent.type: ${event.type}`);
  if (typeof event.platform !== "string" || event.platform.length === 0) throw new TypeError("LiveEvent.platform must be a non-empty string");
  if (typeof event.connector !== "string" || event.connector.length === 0) throw new TypeError("LiveEvent.connector must be a non-empty string");
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0) throw new TypeError("LiveEvent.timestamp must be Unix milliseconds");
  if (!Number.isFinite(event.receivedAt) || event.receivedAt < 0) throw new TypeError("LiveEvent.receivedAt must be Unix milliseconds");
  assertUser(event.user);
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new TypeError("LiveEvent.data must be an object");
  assertTypeData(event.type, event.data);
  if (!("raw" in event)) throw new TypeError("LiveEvent.raw is required");
  return event;
}

export function createLiveEvent(fields) {
  return assertLiveEvent({
    schemaVersion: LIVE_EVENT_SCHEMA_VERSION,
    ...fields,
  });
}

export function createUnknownEvent({
  id,
  platform = "unknown",
  connector,
  nativeEventType,
  timestamp,
  receivedAt,
  raw,
  reason,
}) {
  return createLiveEvent({
    id,
    type: LiveEventType.PLATFORM_UNKNOWN,
    platform,
    connector,
    timestamp,
    receivedAt,
    data: {
      reason,
      ...(nativeEventType ? { nativeEventType } : {}),
    },
    raw,
  });
}

