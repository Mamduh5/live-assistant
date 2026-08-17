import test from "node:test";
import assert from "node:assert/strict";
import { EventHistory, LiveEventType, createLiveEvent } from "../src/index.js";

function event(id, type = LiveEventType.SOCIAL_FOLLOW) {
  return createLiveEvent({
    id,
    type,
    platform: "simulated",
    connector: "test",
    timestamp: 1,
    receivedAt: 2,
    data: type === LiveEventType.CHAT_MESSAGE ? { text: id } : {},
    raw: {},
  });
}

test("retains a bounded history independently of the event bus", () => {
  const history = new EventHistory({ limit: 2 });
  history.record(event("a"));
  history.record(event("b", LiveEventType.CHAT_MESSAGE));
  history.record(event("c", LiveEventType.CHAT_MESSAGE));
  assert.deepEqual(history.getEvents().map(({ id }) => id), ["b", "c"]);
  assert.deepEqual(history.getEvents({ type: LiveEventType.CHAT_MESSAGE, limit: 1 }).map(({ id }) => id), ["c"]);
});

