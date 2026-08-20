import { gunzipSync, gzipSync } from "node:zlib";
import { root, types } from "../../vendor/piratetok-webcast/schema.js";

export const SUPPORTED_WEBCAST_METHODS = Object.freeze([
  "WebcastChatMessage", "WebcastGiftMessage", "WebcastLikeMessage", "WebcastSocialMessage",
  "WebcastRoomUserSeqMessage", "WebcastMemberMessage", "WebcastSubNotifyMessage",
]);
const SUPPORTED = new Set(SUPPORTED_WEBCAST_METHODS);

function number(value) {
  if (value === undefined || value === null) return undefined;
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : undefined;
}

function decodedObject(type, bytes) {
  return type.toObject(type.decode(bytes), { longs: Number, bytes: Buffer, defaults: false });
}

function boundedString(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : undefined;
}

function compactUser(user) {
  if (!user || typeof user !== 'object') return undefined;
  const avatar = boundedString(user.avatarThumb?.urlList?.[0], 2_048);
  return {
    ...(user.id !== undefined ? { id: number(user.id) } : {}),
    ...(boundedString(user.idStr, 64) ? { idStr: boundedString(user.idStr, 64) } : {}),
    ...(boundedString(user.uniqueId, 64) ? { uniqueId: boundedString(user.uniqueId, 64) } : {}),
    ...(boundedString(user.nickname, 256) ? { nickname: boundedString(user.nickname, 256) } : {}),
    ...(avatar ? { avatarThumb: { urlList: [avatar] } } : {}),
    ...(typeof user.isFollower === 'boolean' ? { isFollower: user.isFollower } : {}),
    ...(typeof user.isSubscribe === 'boolean' ? { isSubscribe: user.isSubscribe } : {}),
    ...(typeof user.subscribeInfo?.isSubscribe === 'boolean' ? { subscribeInfo: { isSubscribe: user.subscribeInfo.isSubscribe } } : {}),
    ...(typeof user.userAttr?.isAdmin === 'boolean' ? { userAttr: { isAdmin: user.userAttr.isAdmin } } : {}),
  };
}

function compactCommon(common) {
  return common?.createTime !== undefined ? { createTime: number(common.createTime) } : undefined;
}

function compactIdentity(identity) {
  if (!identity || typeof identity !== 'object') return undefined;
  return Object.fromEntries(['isSubscriberOfAnchor', 'isFollowerOfAnchor', 'isModeratorOfAnchor']
    .filter((field) => typeof identity[field] === 'boolean').map((field) => [field, identity[field]]));
}

function compactData(method, data) {
  const common = compactCommon(data.common);
  const user = compactUser(data.user);
  const base = { ...(common ? { common } : {}), ...(user ? { user } : {}) };
  if (method === 'WebcastChatMessage') return { ...base, ...(boundedString(data.content, 2_000) !== undefined ? { content: boundedString(data.content, 2_000) } : {}), ...(compactIdentity(data.userIdentity) ? { userIdentity: compactIdentity(data.userIdentity) } : {}) };
  if (method === 'WebcastLikeMessage') return { ...base, count: number(data.count), total: number(data.total) };
  if (method === 'WebcastRoomUserSeqMessage') return { ...base, viewerCount: number(data.viewerCount), totalUser: number(data.totalUser) };
  if (method === 'WebcastSocialMessage') return { ...base, action: number(data.action), shareType: number(data.shareType), followCount: number(data.followCount), shareCount: number(data.shareCount) };
  if (method === 'WebcastGiftMessage') return { ...base, giftId: number(data.giftId), repeatCount: number(data.repeatCount), repeatEnd: number(data.repeatEnd), ...(data.gift ? { gift: { id: number(data.gift.id), name: boundedString(data.gift.name, 256), diamondCount: number(data.gift.diamondCount) } } : {}), ...(compactIdentity(data.userIdentity) ? { userIdentity: compactIdentity(data.userIdentity) } : {}) };
  if (method === 'WebcastSubNotifyMessage') return { ...base, ...(compactUser(data.sender) ? { sender: compactUser(data.sender) } : {}), subMonth: number(data.subMonth), subscribeType: number(data.subscribeType), userSubscribeStatus: number(data.userSubscribeStatus) };
  if (method === 'WebcastMemberMessage') return { ...base, memberCount: number(data.memberCount), action: number(data.action) };
  return {};
}

function nativeType(method, data) {
  if (method === "WebcastSocialMessage") {
    const action = number(data.action);
    if (action === 1) return "follow";
    if (action >= 2 && action <= 5) return "share";
    return null;
  }
  return ({
    WebcastChatMessage: "chat", WebcastGiftMessage: "gift", WebcastLikeMessage: "like",
    WebcastRoomUserSeqMessage: "roomUser",
    WebcastSubNotifyMessage: "subscribe",
  })[method] ?? null;
}

export function decodeWebcastFrame(frameBytes, {
  maxFrameBytes = 2 * 1024 * 1024,
  maxDecompressedBytes = 8 * 1024 * 1024,
  maxMessagesPerFrame = 1_000,
} = {}) {
  const bytes = Buffer.from(frameBytes);
  if (bytes.byteLength > maxFrameBytes) throw new RangeError("Webcast frame exceeded the size limit");
  const frame = decodedObject(types.pushFrame, bytes);
  if (frame.payloadType !== "msg" || !frame.payload) return [];
  let payload = Buffer.from(frame.payload);
  if (payload[0] === 0x1f && payload[1] === 0x8b) {
    payload = gunzipSync(payload, { maxOutputLength: maxDecompressedBytes });
  }
  if (payload.byteLength > maxDecompressedBytes) throw new RangeError("Webcast payload exceeded the size limit");
  const response = decodedObject(types.response, payload);
  const events = [];
  for (const message of (response.messages ?? []).slice(0, maxMessagesPerFrame)) {
    if (!SUPPORTED.has(message.method)) continue;
    try {
      const data = compactData(message.method, decodedObject(root.lookupType(message.method), message.payload));
      const event = nativeType(message.method, data);
      if (event) events.push({ event, method: message.method, data });
    } catch {
      events.push({ event: "unknown", method: message.method, data: { reason: "malformed_selected_message" } });
    }
  }
  return events;
}

export function encodeSyntheticWebcastFrame(messages, { gzip = false } = {}) {
  const response = types.response.encode(types.response.create({ messages: messages.map(({ method, data }) => ({
    method,
    payload: root.lookupType(method).encode(root.lookupType(method).create(data)).finish(),
  })) })).finish();
  const payload = gzip ? gzipSync(response) : response;
  return Buffer.from(types.pushFrame.encode(types.pushFrame.create({ payloadType: "msg", payloadEncoding: gzip ? "gzip" : "pb", payload })).finish());
}
