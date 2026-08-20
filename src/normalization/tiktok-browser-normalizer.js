import { randomUUID } from "node:crypto";
import { LiveEventType, createLiveEvent, createUnknownEvent } from "../events/live-event.js";

const TYPE_MAP = new Map([
  ['chat', LiveEventType.CHAT_MESSAGE], ['gift', LiveEventType.GIFT_RECEIVED],
  ['like', LiveEventType.ENGAGEMENT_LIKE], ['follow', LiveEventType.SOCIAL_FOLLOW],
  ['share', LiveEventType.SOCIAL_SHARE], ['roomUser', LiveEventType.ROOM_VIEWER_COUNT],
  ['subscribe', LiveEventType.SUBSCRIPTION_STARTED],
]);

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value) { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function identifier(value) {
  if (typeof value === 'string' && value.length > 0 && value !== '0') return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum ? value : undefined; }

function timestamp(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  return Number.isSafeInteger(milliseconds) ? milliseconds : fallback;
}

function userFrom(data) {
  const native = record(data.user) ? data.user : (record(data.sender) ? data.sender : undefined);
  if (!native) return undefined;
  const identity = record(data.userIdentity) ? data.userIdentity : {};
  const avatarUrl = Array.isArray(native.avatarThumb?.urlList) ? string(native.avatarThumb.urlList[0]) : undefined;
  const result = {
    ...(identifier(native.idStr ?? native.id) ? { id: identifier(native.idStr ?? native.id) } : {}),
    ...(string(native.uniqueId) ? { username: native.uniqueId } : {}),
    ...(string(native.nickname) ? { displayName: native.nickname } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(typeof (identity.isFollowerOfAnchor ?? native.isFollower) === 'boolean' ? { isFollower: identity.isFollowerOfAnchor ?? native.isFollower } : {}),
    ...(typeof (identity.isSubscriberOfAnchor ?? native.isSubscribe ?? native.subscribeInfo?.isSubscribe) === 'boolean' ? { isSubscriber: identity.isSubscriberOfAnchor ?? native.isSubscribe ?? native.subscribeInfo?.isSubscribe } : {}),
    ...(typeof (identity.isModeratorOfAnchor ?? native.userAttr?.isAdmin) === 'boolean' ? { isModerator: identity.isModeratorOfAnchor ?? native.userAttr?.isAdmin } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function canonicalData(type, data) {
  if (type === LiveEventType.CHAT_MESSAGE) return typeof data.content === 'string' ? { text: data.content } : null;
  if (type === LiveEventType.ENGAGEMENT_LIKE) {
    const count = integer(data.count, 1); return count === undefined ? null : { count };
  }
  if (type === LiveEventType.ROOM_VIEWER_COUNT) {
    // viewerCount is current occupancy; totalUser is cumulative room entry and is intentionally not used.
    const count = integer(data.viewerCount); return count === undefined ? null : { count };
  }
  if (type === LiveEventType.GIFT_RECEIVED) {
    if (data.repeatCount !== undefined && integer(data.repeatCount, 1) === undefined) return null;
    if (data.repeatEnd !== undefined && ![0, 1].includes(data.repeatEnd)) return null;
    const quantity = integer(data.repeatCount, 1) ?? 1;
    const giftId = identifier(data.gift?.id ?? data.giftId);
    const giftName = string(data.gift?.name);
    const unitCoins = integer(data.gift?.diamondCount);
    const repeatEnd = integer(data.repeatEnd);
    return {
      ...(giftId ? { giftId } : {}), ...(giftName ? { giftName } : {}), quantity,
      ...(unitCoins !== undefined ? { unitCoins } : {}),
      ...(repeatEnd !== undefined ? { streak: { active: repeatEnd === 0, completed: repeatEnd === 1, repeatCount: quantity } } : {}),
    };
  }
  return {};
}

export function normalizeTikTokBrowserEvent(raw, { clock = Date.now, idFactory = randomUUID } = {}) {
  const receivedAt = clock(); const id = idFactory();
  const nativeEventType = record(raw) && typeof raw.method === 'string' ? raw.method : undefined;
  const data = record(raw?.data) ? raw.data : undefined;
  const sourceTimestamp = timestamp(data?.common?.createTime, receivedAt);
  const unknown = (reason) => createUnknownEvent({ id, platform: 'tiktok', connector: 'tiktok-browser', nativeEventType,
    timestamp: sourceTimestamp, receivedAt, raw, reason });
  if (!record(raw) || typeof raw.event !== 'string' || !data) return unknown('malformed_payload');
  if (raw.event === 'unknown') return unknown(data.reason ?? 'malformed_selected_message');
  if (raw.event === 'member') return unknown('unsupported_event_type');
  const type = TYPE_MAP.get(raw.event); if (!type) return unknown('unsupported_event_type');
  const canonical = canonicalData(type, data); if (canonical === null) return unknown('malformed_event_data');
  const user = userFrom(data);
  return createLiveEvent({ id, platform: 'tiktok', connector: 'tiktok-browser', type, timestamp: sourceTimestamp,
    receivedAt, ...(user ? { user } : {}), data: canonical, raw });
}
