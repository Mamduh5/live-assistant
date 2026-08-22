import test from "node:test";
import assert from "node:assert/strict";
import { LiveAssistantRuntime, LiveEventType, loadConfig, normalizeTikTokBrowserEvent } from "../src/index.js";

test("fake TikTok browser connector flows through normalizer, runtime, history and attention offline", async () => {
  const connector = {
    name: 'tiktok-browser', state: 'idle',
    subscribeState(handler) { handler(this.state); return () => {}; },
    async *events() {
      this.state = 'connected';
      yield { event: 'chat', method: 'WebcastChatMessage', data: { common: { createTime: 1_700_000_000_000 }, user: { idStr: '1', uniqueId: 'viewer-1', nickname: 'Test Viewer' }, content: 'Can you test this?' } };
    },
    async close() { this.state = 'disconnected'; },
    counters: { webcastFrames: 1, decodedEvents: 1 },
    recovery: { lastReason: 'initial_start' },
    navigation: { lastClassification: 'initial' },
  };
  const config = loadConfig({});
  const runtime = new LiveAssistantRuntime({ config, connector, normalize: normalizeTikTokBrowserEvent, attentionMode: 'deterministic', speechEngine: null });
  runtime.start(); const result = await runtime.waitForCompletion();
  assert.equal(result.connector.status, 'completed');
  assert.equal(runtime.getRecentEvents({ limit: 1 })[0].type, LiveEventType.CHAT_MESSAGE);
  assert.deepEqual(runtime.getStatus().connector.counters, { webcastFrames: 1, decodedEvents: 1 });
  assert.deepEqual(runtime.getStatus().connector.recovery, { lastReason: 'initial_start' });
  assert.deepEqual(runtime.getStatus().connector.navigation, { lastClassification: 'initial' });
  await runtime.stop();
});
