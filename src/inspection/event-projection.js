const PREVIEW_LENGTH = 120;

function truncate(value, limit = PREVIEW_LENGTH) {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function userName(event) {
  return event.user?.displayName ?? event.user?.username ?? event.user?.id ?? null;
}

export function summarizeEvent(event) {
  const name = userName(event);
  switch (event.type) {
    case "chat.message":
      return truncate(event.data.text);
    case "gift.received": {
      const gift = event.data.giftName ?? event.data.giftId ?? "gift";
      return `${name ? `${name}: ` : ""}${gift} × ${event.data.quantity}`;
    }
    case "room.viewer_count":
      return `${event.data.count} viewers`;
    case "platform.unknown":
      return truncate(event.data.nativeEventType ?? event.data.reason);
    case "social.follow":
      return name ? `${name} followed` : "New follower";
    case "social.share":
      return name ? `${name} shared` : "Stream shared";
    case "engagement.like":
      return `${name ? `${name}: ` : ""}${event.data.count} like${event.data.count === 1 ? "" : "s"}`;
    case "subscription.started":
      return name ? `${name} subscribed` : "New subscription";
    default:
      return event.type;
  }
}

export function projectEvent(event, { includeRaw = false } = {}) {
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    type: event.type,
    platform: event.platform,
    connector: event.connector,
    timestamp: event.timestamp,
    receivedAt: event.receivedAt,
    user: event.user ? { ...event.user } : null,
    data: structuredClone(event.data),
    summary: summarizeEvent(event),
    ...(includeRaw ? { raw: structuredClone(event.raw) } : {}),
  };
}
