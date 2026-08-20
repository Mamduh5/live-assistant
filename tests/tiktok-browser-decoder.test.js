import test from "node:test";
import assert from "node:assert/strict";
import { decodeWebcastFrame, encodeSyntheticWebcastFrame } from "../src/index.js";

const user = { id: 101, idStr: '101', uniqueId: 'viewer-1', nickname: 'Test Viewer', avatarThumb: { urlList: ['https://example.invalid/avatar.png'] } };
const common = { createTime: 1_700_000_000_000 };

test("Webcast decoder handles uncompressed selected messages and exact field semantics", () => {
  const frame = encodeSyntheticWebcastFrame([
    { method: 'WebcastChatMessage', data: { common, user, content: 'hello' } },
    { method: 'WebcastLikeMessage', data: { common, user, count: 15, total: 31 } },
    { method: 'WebcastRoomUserSeqMessage', data: { common, viewerCount: 2, totalUser: 99 } },
    { method: 'WebcastGiftMessage', data: { common, user, giftId: 7, repeatCount: 3, repeatEnd: 1, gift: { id: 7, name: 'Synthetic Rose', diamondCount: 1 } } },
    { method: 'WebcastSocialMessage', data: { common, user, action: 1 } },
    { method: 'WebcastSocialMessage', data: { common, user, action: 3 } },
    { method: 'WebcastSubNotifyMessage', data: { common, sender: user, subMonth: 2 } },
    { method: 'WebcastMemberMessage', data: { common, user, action: 1 } },
  ]);
  const events = decodeWebcastFrame(frame);
  assert.deepEqual(events.map(({ event }) => event), ['chat', 'like', 'roomUser', 'gift', 'follow', 'share', 'subscribe']);
  assert.equal(events[1].data.count, 15);
  assert.equal(events[2].data.viewerCount, 2);
});

test("Webcast decoder handles gzip and ignores non-msg and unsupported methods", () => {
  const compressed = encodeSyntheticWebcastFrame([{ method: 'WebcastChatMessage', data: { common, user, content: 'gzip' } }], { gzip: true });
  assert.equal(decodeWebcastFrame(compressed)[0].data.content, 'gzip');
  const control = Buffer.from([0x3a, 0x02, 0x68, 0x62]); // PushFrame payloadType = hb
  assert.deepEqual(decodeWebcastFrame(control), []);
  const unsupported = encodeSyntheticWebcastFrame([{ method: 'WebcastMemberMessage', data: { common, user, action: 2 } }]);
  assert.equal(decodeWebcastFrame(unsupported).length, 0);
  assert.throws(() => decodeWebcastFrame(Buffer.from([0xff, 0xff])));
});

test("unsupported protocol methods do not enter the output stream", async () => {
  const { root, types } = await import('../src/vendor/piratetok-webcast/schema.js');
  const payload = types.response.encode(types.response.create({ messages: [{ method: 'WebcastInternalNoiseMessage', payload: Buffer.from([1, 2]) }] })).finish();
  const frame = types.pushFrame.encode(types.pushFrame.create({ payloadType: 'msg', payload })).finish();
  assert.deepEqual(decodeWebcastFrame(frame), []);
  assert.equal(root.lookupType('WebcastChatMessage').name, 'WebcastChatMessage');
  const memberType = root.lookupType('WebcastMemberMessage');
  assert.equal(memberType.toObject(memberType.decode(memberType.encode({ user, action: 1 }).finish()), { longs: Number }).action, 1);
});
