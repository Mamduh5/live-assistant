import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventType, normalizeTikTokBrowserEvent } from "../src/index.js";

const options = { clock: () => 1_800_000_000_000, idFactory: () => 'event-1' };
const user = { idStr: '42', uniqueId: 'viewer-1', nickname: 'Test Viewer', isFollower: true, isSubscribe: true, userAttr: { isAdmin: true }, avatarThumb: { urlList: ['https://example.invalid/a.png'] } };
function native(event, data, method = `Webcast${event}Message`) { return { event, method, data: { common: { createTime: 1_700_000_000 }, ...data } }; }

test("TikTok browser normalizer maps supported events into canonical v1", () => {
  const cases = [
    [native('chat', { user, content: 'hello' }, 'WebcastChatMessage'), LiveEventType.CHAT_MESSAGE, { text: 'hello' }],
    [native('like', { user, count: 15, total: 31 }, 'WebcastLikeMessage'), LiveEventType.ENGAGEMENT_LIKE, { count: 15 }],
    [native('roomUser', { viewerCount: 2, totalUser: 99 }, 'WebcastRoomUserSeqMessage'), LiveEventType.ROOM_VIEWER_COUNT, { count: 2 }],
    [native('follow', { user }, 'WebcastSocialMessage'), LiveEventType.SOCIAL_FOLLOW, {}],
    [native('share', { user }, 'WebcastSocialMessage'), LiveEventType.SOCIAL_SHARE, {}],
    [native('subscribe', { sender: user }, 'WebcastSubNotifyMessage'), LiveEventType.SUBSCRIPTION_STARTED, {}],
  ];
  for (const [input, type, data] of cases) {
    const event = normalizeTikTokBrowserEvent(input, options);
    assert.equal(event.type, type); assert.deepEqual(event.data, data);
    assert.equal(event.platform, 'tiktok'); assert.equal(event.connector, 'tiktok-browser');
    assert.equal(event.timestamp, 1_700_000_000_000);
  }
  const chat = normalizeTikTokBrowserEvent(cases[0][0], options);
  assert.deepEqual(chat.user, { id: '42', username: 'viewer-1', displayName: 'Test Viewer', avatarUrl: 'https://example.invalid/a.png', isFollower: true, isSubscriber: true, isModerator: true });
});

test("gift mapping preserves quantity, coins and streak semantics", () => {
  const event = normalizeTikTokBrowserEvent(native('gift', { user, giftId: 7, repeatCount: 3, repeatEnd: 1, gift: { id: 7, name: 'Synthetic Rose', diamondCount: 1 } }, 'WebcastGiftMessage'), options);
  assert.equal(event.type, LiveEventType.GIFT_RECEIVED);
  assert.deepEqual(event.data, { giftId: '7', giftName: 'Synthetic Rose', quantity: 3, unitCoins: 1, streak: { active: false, completed: true, repeatCount: 3 } });
});

test("malformed selected events and member diagnostics become platform.unknown", () => {
  assert.equal(normalizeTikTokBrowserEvent(native('chat', { user }, 'WebcastChatMessage'), options).type, LiveEventType.PLATFORM_UNKNOWN);
  assert.equal(normalizeTikTokBrowserEvent(native('member', { user, action: 1 }, 'WebcastMemberMessage'), options).data.reason, 'unsupported_event_type');
  assert.equal(normalizeTikTokBrowserEvent({ event: 'unknown', method: 'WebcastLikeMessage', data: { reason: 'malformed_selected_message' } }, options).type, LiveEventType.PLATFORM_UNKNOWN);
});
