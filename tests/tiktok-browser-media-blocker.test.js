import test from "node:test";
import assert from "node:assert/strict";
import { installTikTokMediaBlocker, shouldBlockTikTokMedia } from "../src/index.js";

const BLOCKED = [
  { resourceType: "Media", url: "https://example.test/not-obviously-media" },
  { resourceType: "Other", url: "https://pull-flv-w77-sg01.tiktokcdn.com/game/stream-123_sd5.flv" },
  { resourceType: "Other", url: "https://pull-f5-sg01.tiktokcdn.com/game/stream-123_sd5.flv" },
  { resourceType: "Other", url: "https://example.tiktokcdn.com/path/stream.m3u8" },
  { resourceType: "Other", url: "https://example.test/video.MP4?token=private" },
  { resourceType: "Other", url: "https://example.test/chunk.m4s" },
  { resourceType: "Other", url: "https://pull-flv.example.test/live" },
  { resourceType: "Other", url: "https://pull-hls.example.test/live" },
];

const CONTINUED = [
  { resourceType: "Script", url: "https://www.tiktok.com/app.js" },
  { resourceType: "Document", url: "https://www.tiktok.com/@creator/live" },
  { resourceType: "XHR", url: "https://www.tiktok.com/api/live/detail/?token=private" },
  { resourceType: "XHR", url: "https://www.tiktok.com/api/live/detail/?next=stream.flv" },
  { resourceType: "Fetch", url: "https://www.tiktok.com/api/comment/list" },
  { resourceType: "WebSocket", url: "wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/" },
  { resourceType: "Stylesheet", url: "https://www.tiktok.com/app.css" },
];

test("media classifier blocks media types and real-shaped livestream paths", () => {
  for (const request of BLOCKED) assert.equal(shouldBlockTikTokMedia(request), true, request.url);
  for (const request of CONTINUED) assert.equal(shouldBlockTikTokMedia(request), false, request.url);
});

function blockerHarness({ failBlock = false } = {}) {
  const calls = [];
  const diagnostics = [];
  let handler;
  let unsubscribeCalls = 0;
  const client = {
    closed: false,
    subscribe(method, candidate, options) {
      assert.equal(method, "Fetch.requestPaused");
      assert.equal(options.sessionId, "session-1");
      handler = candidate;
      return () => { unsubscribeCalls += 1; handler = undefined; };
    },
    async send(method, params, options) {
      calls.push({ method, params, options });
      if (failBlock && method === "Fetch.failRequest") throw new Error("failed https://cdn.test/video.flv?secret=yes");
      return {};
    },
  };
  return { client, calls, diagnostics, emit(params) { handler(params); }, get unsubscribeCalls() { return unsubscribeCalls; } };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("Fetch interception resolves every paused request and counts only successful blocks", async () => {
  const h = blockerHarness();
  let blocked = 0;
  const cleanup = await installTikTokMediaBlocker(h.client, {
    sessionId: "session-1",
    onBlocked: () => { blocked += 1; },
    onDiagnostic: (value) => h.diagnostics.push(value),
  });
  assert.equal(h.calls[0].method, "Fetch.enable");

  const requests = [...BLOCKED, ...CONTINUED];
  requests.forEach((request, index) => h.emit({ requestId: `request-${index}`, request: { url: request.url }, resourceType: request.resourceType }));
  await settle();

  const resolutions = h.calls.filter(({ method }) => method === "Fetch.failRequest" || method === "Fetch.continueRequest");
  assert.equal(resolutions.length, requests.length);
  assert.equal(resolutions.filter(({ method }) => method === "Fetch.failRequest").length, BLOCKED.length);
  assert.equal(resolutions.filter(({ method }) => method === "Fetch.continueRequest").length, CONTINUED.length);
  assert.equal(resolutions.find(({ method }) => method === "Fetch.failRequest").params.errorReason, "Aborted");
  assert.equal(blocked, BLOCKED.length);

  await cleanup();
  assert.equal(h.calls.at(-1).method, "Fetch.disable");
  assert.equal(h.unsubscribeCalls, 1);
});

test("failed blocking falls back to continuation without leaking request URLs", async () => {
  const h = blockerHarness({ failBlock: true });
  let blocked = 0;
  const cleanup = await installTikTokMediaBlocker(h.client, {
    sessionId: "session-1",
    onBlocked: () => { blocked += 1; },
    onDiagnostic: (value) => h.diagnostics.push(value),
  });
  h.emit({ requestId: "media-1", request: { url: "https://cdn.test/video.flv?secret=yes" }, resourceType: "Media" });
  await settle();
  assert.deepEqual(h.calls.slice(1, 3).map(({ method }) => method), ["Fetch.failRequest", "Fetch.continueRequest"]);
  assert.equal(blocked, 0);
  assert.equal(JSON.stringify(h.diagnostics).includes("secret=yes"), false);
  await cleanup();
});
