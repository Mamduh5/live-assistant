// Minimal derivative of PirateTok/live-js protobuf schema, revision
// ad822caecf91c494580102e3c1ded6f98ace71be. See third_party/piratetok-webcast/.
import protobuf from "protobufjs";

const { Root, Type, Field } = protobuf;
export const root = new Root();

const add = (type) => { root.add(type); return type; };

add(new Type("WebcastPushFrame").add(new Field("payloadType", 7, "string")).add(new Field("payload", 8, "bytes")));
add(new Type("ResponseMessage").add(new Field("method", 1, "string")).add(new Field("payload", 2, "bytes")));
add(new Type("WebcastResponse").add(new Field("messages", 1, "ResponseMessage", "repeated")));

add(new Type("Image").add(new Field("urlList", 1, "string", "repeated")));
add(new Type("Common").add(new Field("createTime", 4, "int64")));
add(new Type("SubscribeInfo").add(new Field("isSubscribe", 2, "bool")));
add(new Type("UserAttr").add(new Field("isAdmin", 2, "bool")));
add(new Type("User").add(new Field("id", 1, "int64")).add(new Field("nickname", 3, "string"))
  .add(new Field("avatarThumb", 9, "Image"))
  .add(new Field("userAttr", 32, "UserAttr")).add(new Field("uniqueId", 38, "string"))
  .add(new Field("subscribeInfo", 63, "SubscribeInfo")).add(new Field("idStr", 1028, "string"))
  .add(new Field("isFollower", 1029, "bool")).add(new Field("isSubscribe", 1090, "bool")));
add(new Type("UserIdentity").add(new Field("isSubscriberOfAnchor", 2, "bool"))
  .add(new Field("isFollowerOfAnchor", 4, "bool")).add(new Field("isModeratorOfAnchor", 5, "bool")));
add(new Type("GiftStruct").add(new Field("id", 5, "int64")).add(new Field("diamondCount", 12, "int32"))
  .add(new Field("name", 16, "string")));

add(new Type("WebcastChatMessage").add(new Field("common", 1, "Common")).add(new Field("user", 2, "User"))
  .add(new Field("content", 3, "string")).add(new Field("userIdentity", 18, "UserIdentity")));
add(new Type("WebcastGiftMessage").add(new Field("common", 1, "Common")).add(new Field("giftId", 2, "int32"))
  .add(new Field("repeatCount", 5, "int32")).add(new Field("user", 7, "User")).add(new Field("repeatEnd", 9, "int32"))
  .add(new Field("gift", 15, "GiftStruct")).add(new Field("userIdentity", 32, "UserIdentity")));
add(new Type("WebcastLikeMessage").add(new Field("common", 1, "Common")).add(new Field("count", 2, "int32"))
  .add(new Field("total", 3, "int64")).add(new Field("user", 5, "User")));
add(new Type("WebcastSocialMessage").add(new Field("common", 1, "Common")).add(new Field("user", 2, "User"))
  .add(new Field("shareType", 3, "int64")).add(new Field("action", 4, "int64"))
  .add(new Field("followCount", 6, "int64")).add(new Field("shareCount", 8, "int32")));
add(new Type("WebcastRoomUserSeqMessage").add(new Field("common", 1, "Common"))
  .add(new Field("viewerCount", 3, "int64"))
  .add(new Field("totalUser", 7, "int64")));
add(new Type("WebcastMemberMessage").add(new Field("common", 1, "Common")).add(new Field("user", 2, "User"))
  .add(new Field("memberCount", 3, "int32")).add(new Field("action", 10, "int32")));
add(new Type("WebcastSubNotifyMessage").add(new Field("common", 1, "Common")).add(new Field("sender", 2, "User"))
  .add(new Field("subMonth", 4, "int32")).add(new Field("subscribeType", 5, "int32"))
  .add(new Field("userSubscribeStatus", 7, "int32")).add(new Field("user", 11, "User")));

export const types = Object.freeze({
  pushFrame: root.lookupType("WebcastPushFrame"),
  response: root.lookupType("WebcastResponse"),
});
