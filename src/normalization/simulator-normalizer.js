import { randomUUID } from "node:crypto";
import {
  LIVE_EVENT_SCHEMA_VERSION,
  LiveEventType,
  assertLiveEvent,
  createUnknownEvent,
} from "../events/live-event.js";

const TYPE_MAP = new Map([
  ["comment", LiveEventType.CHAT_MESSAGE],
  ["gift", LiveEventType.GIFT],
  ["follow", LiveEventType.FOLLOW],
  ["subscription", LiveEventType.SUBSCRIPTION],
  ["like", LiveEventType.LIKE],
  ["share", LiveEventType.SHARE],
  ["viewer_count", LiveEventType.VIEWER_COUNT],
]);

function isoDate(value, fallback) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function actorFrom(payload) {
  if (!payload.user || typeof payload.user !== "object") return null;
  const id = typeof payload.user.id === "string" ? payload.user.id : null;
  const displayName = typeof payload.user.name === "string" ? payload.user.name : null;
  return id || displayName ? { id, displayName } : null;
}

function canonicalData(type, payload) {
  switch (type) {
    case LiveEventType.CHAT_MESSAGE:
      return typeof payload.text === "string" ? { text: payload.text } : null;
    case LiveEventType.GIFT:
      if (!payload.gift || typeof payload.gift !== "object") return null;
      return {
        giftId: typeof payload.gift?.id === "string" ? payload.gift.id : null,
        name: typeof payload.gift?.name === "string" ? payload.gift.name : null,
        count: Number.isSafeInteger(payload.gift?.count) && payload.gift.count > 0 ? payload.gift.count : 1,
        streakEnded: payload.gift?.streakEnded === true,
      };
    case LiveEventType.LIKE:
      if (payload.count !== undefined && (!Number.isSafeInteger(payload.count) || payload.count < 1)) return null;
      return { count: payload.count ?? 1 };
    case LiveEventType.VIEWER_COUNT:
      return Number.isSafeInteger(payload.count) && payload.count >= 0 ? { count: payload.count } : null;
    default:
      return {};
  }
}

export function normalizeSimulatorPayload(raw, {
  clock = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  const receivedAt = clock().toISOString();
  const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const nativeEventType = isObject && typeof raw.kind === "string" ? raw.kind : undefined;
  const type = nativeEventType ? TYPE_MAP.get(nativeEventType) : undefined;
  const id = isObject && typeof raw.id === "string" && raw.id.length > 0 ? raw.id : idFactory();
  const platform = isObject && typeof raw.platform === "string" && raw.platform.length > 0 ? raw.platform : "simulated";
  const occurredAt = isObject ? isoDate(raw.timestamp, receivedAt) : receivedAt;

  if (!isObject || !type) {
    return createUnknownEvent({
      id,
      platform,
      connector: "simulator",
      nativeEventType,
      occurredAt,
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
      connector: "simulator",
      nativeEventType,
      occurredAt,
      receivedAt,
      raw,
      reason: "malformed_event_data",
    });
  }

  return assertLiveEvent({
    schemaVersion: LIVE_EVENT_SCHEMA_VERSION,
    id,
    type,
    platform,
    occurredAt,
    receivedAt,
    source: { connector: "simulator", nativeEventType },
    actor: actorFrom(raw),
    data,
    raw,
  });
}
