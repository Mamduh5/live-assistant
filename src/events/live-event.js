export const LIVE_EVENT_SCHEMA_VERSION = 1;

export const LiveEventType = Object.freeze({
  CHAT_MESSAGE: "chat.message",
  GIFT: "gift",
  FOLLOW: "follow",
  SUBSCRIPTION: "subscription",
  LIKE: "like",
  SHARE: "share",
  VIEWER_COUNT: "room.viewer_count",
  UNKNOWN: "unknown",
});

const EVENT_TYPES = new Set(Object.values(LiveEventType));

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function assertLiveEvent(event) {
  if (!event || typeof event !== "object") throw new TypeError("LiveEvent must be an object");
  if (event.schemaVersion !== LIVE_EVENT_SCHEMA_VERSION) throw new TypeError("Unsupported LiveEvent schemaVersion");
  if (typeof event.id !== "string" || event.id.length === 0) throw new TypeError("LiveEvent.id must be a non-empty string");
  if (!EVENT_TYPES.has(event.type)) throw new TypeError(`Unsupported LiveEvent.type: ${event.type}`);
  if (typeof event.platform !== "string" || event.platform.length === 0) throw new TypeError("LiveEvent.platform must be a non-empty string");
  if (!isIsoDate(event.occurredAt) || !isIsoDate(event.receivedAt)) throw new TypeError("LiveEvent timestamps must be ISO date strings");
  if (!event.source || typeof event.source.connector !== "string") throw new TypeError("LiveEvent.source.connector is required");
  if (!event.data || typeof event.data !== "object") throw new TypeError("LiveEvent.data must be an object");
  if (!("raw" in event)) throw new TypeError("LiveEvent.raw is required");
  return event;
}

export function createUnknownEvent({
  id,
  platform = "unknown",
  connector,
  nativeEventType,
  occurredAt,
  receivedAt,
  raw,
  reason,
}) {
  return assertLiveEvent({
    schemaVersion: LIVE_EVENT_SCHEMA_VERSION,
    id,
    type: LiveEventType.UNKNOWN,
    platform,
    occurredAt,
    receivedAt,
    source: {
      connector,
      ...(nativeEventType ? { nativeEventType } : {}),
    },
    actor: null,
    data: { reason },
    raw,
  });
}

