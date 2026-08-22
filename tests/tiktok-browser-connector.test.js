import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, TikTokBrowserConnector, binaryFrameFromCdp,
  CdpProtocolError, closeOwnedTarget, createOwnedTarget, createSafeBackgroundTarget,
  encodeSyntheticWebcastFrame, isTikTokWebcastSocket,
  normalizeTikTokUsername,
} from "../src/index.js";

test("Webcast socket matching is conservative and diagnostics can drop queries", () => {
  assert.equal(isTikTokWebcastSocket('wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?token=secret'), true);
  assert.equal(isTikTokWebcastSocket('wss://webcast-ws.eu.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/'), true);
  assert.equal(isTikTokWebcastSocket('wss://im-ws-sg.tiktok.com/ws/v2'), false);
  assert.equal(isTikTokWebcastSocket('wss://example.com/webcast/im/ws_proxy/'), false);
});

test("CDP binary conversion accepts only opcode 2 from selected sockets", () => {
  const selected = new Set(['webcast']);
  assert.deepEqual(binaryFrameFromCdp({ requestId: 'webcast', response: { opcode: 2, payloadData: Buffer.from('hello').toString('base64') } }, selected), Buffer.from('hello'));
  assert.equal(binaryFrameFromCdp({ requestId: 'webcast', response: { opcode: 1, payloadData: 'text' } }, selected), null);
  assert.equal(binaryFrameFromCdp({ requestId: 'other', response: { opcode: 2, payloadData: 'AA==' } }, selected), null);
});

test("owned target lifecycle enables observation and closes only its target", async () => {
  const calls = [];
  const client = {
    closed: false,
    async send(method, params, options) {
      calls.push({ method, params, options });
      if (method === 'Target.createTarget') return { targetId: 'owned-page' };
      if (method === 'Target.attachToTarget') return { sessionId: 'flat-session' };
      return {};
    },
  };
  const owned = await createOwnedTarget(client, { username: 'synthetic_user', signal: new AbortController().signal });
  assert.deepEqual(owned, { targetId: 'owned-page', sessionId: 'flat-session', mode: 'hidden' });
  assert.deepEqual(calls.map(({ method }) => method), ['Target.createTarget', 'Target.attachToTarget', 'Network.enable', 'Page.enable', 'Page.navigate']);
  assert.deepEqual(calls[0].params, { url: 'about:blank', background: true, hidden: true });
  assert.equal('browserContextId' in calls[0].params, false);
  assert.equal(calls.some(({ method }) => method === 'Target.activateTarget'), false);
  assert.equal(calls.some(({ params }) => params?.newWindow === true), false);
  assert.equal(calls[4].params.url, 'https://www.tiktok.com/@synthetic_user/live');
  await closeOwnedTarget(client, owned.targetId);
  assert.equal(calls.at(-1).method, 'Target.closeTarget');
  assert.equal(calls.some(({ method }) => method === 'Browser.close'), false);
});

test("safe target creation capability fallback never requests a foreground target", async () => {
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      if (calls.length < 3) throw new CdpProtocolError(method, { code: -32602, message: 'Invalid parameters' });
      return { targetId: 'safe-page' };
    },
  };
  assert.deepEqual(await createSafeBackgroundTarget(client), { targetId: 'safe-page', mode: 'background' });
  assert.deepEqual(calls.map(({ params }) => params), [
    { url: 'about:blank', background: true, hidden: true },
    { url: 'about:blank', background: true, focus: false },
    { url: 'about:blank', background: true },
  ]);
  assert.equal(calls.every(({ params }) => params.background === true && params.newWindow !== true && !('browserContextId' in params)), true);

  const rejectedCalls = [];
  await assert.rejects(createSafeBackgroundTarget({
    async send(method, params) {
      rejectedCalls.push({ method, params });
      throw new CdpProtocolError(method, { code: -32602, message: 'Unknown parameter' });
    },
  }), /does not support safe background target creation/u);
  assert.equal(rejectedCalls.length, 3);
  assert.equal(rejectedCalls.every(({ params }) => params.background === true), true);
});

test("username normalization strips one leading at-sign and validates safely", () => {
  assert.equal(normalizeTikTokUsername('@viewer.test'), 'viewer.test');
  assert.equal(normalizeTikTokUsername('bad/name'), null);
  assert.equal(normalizeTikTokUsername(''), null);
});

class AutoSocket {
  listeners = new Map(); sent = []; readyState = 0; closeCalls = 0;
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler)); }
  emit(type, value = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(value); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.closeCalls += 1; this.readyState = 3; this.emit('close'); }
  send(text) {
    const command = JSON.parse(text); this.sent.push(command);
    const results = {
      'Target.createTarget': { targetId: 'owned-page' },
      'Target.attachToTarget': { sessionId: 'flat-session' },
    };
    queueMicrotask(() => {
      this.message({ id: command.id, result: results[command.method] ?? {} });
      if (command.method === 'Page.navigate') queueMicrotask(() => this.message({ method: 'Network.webSocketCreated', sessionId: 'flat-session', params: { requestId: 'webcast-1', url: 'wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?private=value' } }));
    });
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); }
  throw new Error('condition timed out');
}

class FakeTimers {
  now = 0; nextId = 1; tasks = new Map();
  set = (callback, delayMs) => {
    const id = this.nextId++; this.tasks.set(id, { callback, due: this.now + delayMs }); return id;
  };
  clear = (id) => { this.tasks.delete(id); };
  advance(delayMs) {
    const target = this.now + delayMs;
    while (true) {
      const entry = [...this.tasks.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry || entry[1].due > target) break;
      this.now = entry[1].due; this.tasks.delete(entry[0]); entry[1].callback();
    }
    this.now = target;
  }
}

function connectorHarness({ maxQueuedEvents = DEFAULT_CONFIG.tiktokBrowser.maxQueuedEvents, replacementSocketTimeoutMs = 1_000 } = {}) {
  const sockets = []; const waits = []; const states = []; const diagnostics = [];
  const timers = new FakeTimers();
  const connector = new TikTokBrowserConnector({
    ...DEFAULT_CONFIG.tiktokBrowser, username: 'synthetic_user', maxQueuedEvents, navigationTimeoutMs: 1_000,
    webcastSocketTimeoutMs: 1_000, replacementSocketTimeoutMs,
    reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, jitterRatio: 0 },
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/synthetic' }) }),
    webSocketFactory: () => { const socket = new AutoSocket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket; },
    sleep: (delayMs, signal) => new Promise((resolve) => { waits.push({ delayMs, resolve }); signal.addEventListener('abort', resolve, { once: true }); }),
    random: () => 0.5, onDiagnostic: (value) => diagnostics.push(value), setTimer: timers.set, clearTimer: timers.clear,
  });
  connector.subscribeState((state) => states.push(state));
  return { connector, sockets, waits, states, diagnostics, timers };
}

test("an open Webcast socket remains healthy through five and thirty minutes of frame silence", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected');
  const navigationCount = () => h.sockets.flatMap(({ sent }) => sent).filter(({ method }) => method === 'Page.navigate').length;
  h.timers.advance(5 * 60_000);
  assert.equal(h.connector.state, 'connected'); assert.equal(navigationCount(), 1); assert.equal(h.sockets.length, 1);
  h.timers.advance(25 * 60_000);
  assert.equal(h.connector.state, 'connected'); assert.equal(navigationCount(), 1); assert.equal(h.sockets.length, 1);
  assert.equal(h.connector.counters.targetCreations, 1);
  assert.equal(h.connector.counters.targetRecoveries, 0);
  assert.equal(h.connector.counters.applicationNavigations, 1);
  await h.connector.close(); assert.equal((await next).done, true); assert.equal(h.timers.tasks.size, 0);
});

test("closing one of two selected sockets keeps the session connected", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected'); const socket = h.sockets[0];
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'flat-session', params: { requestId: 'webcast-2', url: 'wss://webcast-ws.eu.tiktok.com/webcast/im/ws_proxy/replacement/' } });
  socket.message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  assert.equal(h.connector.state, 'connected'); assert.equal(h.timers.tasks.size, 0);
  await h.connector.close(); assert.equal((await next).done, true);
});

test("the last socket waits for a replacement without recreating the page", async () => {
  const h = connectorHarness({ replacementSocketTimeoutMs: 5_000 }); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected'); const socket = h.sockets[0];
  socket.message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  h.timers.advance(4_999);
  assert.equal(h.connector.state, 'reconnecting'); assert.equal(socket.sent.filter(({ method }) => method === 'Page.navigate').length, 1);
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'flat-session', params: { requestId: 'replacement', url: 'wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/replacement/' } });
  h.timers.advance(10_000);
  assert.equal(h.connector.state, 'connected'); assert.equal(socket.sent.filter(({ method }) => method === 'Page.navigate').length, 1); assert.equal(h.timers.tasks.size, 0);
  assert.equal(h.connector.counters.webcastSocketClosed, 1);
  assert.equal(h.connector.counters.webcastSocketCreated, 2);
  assert.equal(h.connector.counters.targetRecoveries, 0);
  await h.connector.close(); assert.equal((await next).done, true);
});

test("replacement timeout and owned target crash recover the owned session", async () => {
  const timed = connectorHarness({ replacementSocketTimeoutMs: 500 }); const timedIterator = timed.connector.events()[Symbol.asyncIterator](); const timedNext = timedIterator.next();
  await until(() => timed.connector.state === 'connected');
  timed.sockets[0].message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  timed.timers.advance(500); await until(() => timed.waits.length === 1);
  assert.equal(timed.sockets[0].sent.some(({ method }) => method === 'Target.closeTarget'), true);
  assert.equal(timed.connector.counters.replacementSocketTimeouts, 1);
  assert.equal(timed.connector.recovery.lastReason, 'replacement_timeout');
  timed.waits[0].resolve(); await until(() => timed.sockets.length === 2 && timed.connector.state === 'connected');
  const timedCreate = timed.sockets[1].sent.find(({ method }) => method === 'Target.createTarget');
  assert.deepEqual(timedCreate.params, { url: 'about:blank', background: true, hidden: true });
  timed.sockets[1].message({ method: 'Page.frameNavigated', sessionId: 'flat-session', params: { frame: { id: 'recovered-top', url: 'https://www.tiktok.com/@synthetic_user/live' } } });
  assert.equal(timed.connector.navigation.lastClassification, 'application_recovery');
  assert.equal(timed.connector.counters.targetRecoveries, 1);
  assert.equal(timed.sockets.flatMap(({ sent }) => sent).some(({ method, params }) => method === 'Target.activateTarget' || params?.newWindow === true), false);
  await timed.connector.close(); assert.equal((await timedNext).done, true); assert.equal(timed.timers.tasks.size, 0);

  const crashed = connectorHarness(); const crashedIterator = crashed.connector.events()[Symbol.asyncIterator](); const crashedNext = crashedIterator.next();
  await until(() => crashed.connector.state === 'connected');
  crashed.sockets[0].message({ method: 'Target.targetCrashed', params: { targetId: 'owned-page' } });
  await until(() => crashed.waits.length === 1);
  assert.equal(crashed.sockets[0].sent.some(({ method }) => method === 'Target.closeTarget'), true);
  assert.equal(crashed.connector.counters.targetCrashes, 1);
  assert.equal(crashed.connector.recovery.lastReason, 'target_crashed');
  crashed.waits[0].resolve(); await until(() => crashed.sockets.length === 2 && crashed.connector.state === 'connected');
  assert.deepEqual(crashed.sockets[1].sent.find(({ method }) => method === 'Target.createTarget').params, { url: 'about:blank', background: true, hidden: true });
  await crashed.connector.close(); assert.equal((await crashedNext).done, true);
});

test("top-level navigation is classified without triggering recovery", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected'); const socket = h.sockets[0];
  socket.message({ method: 'Page.frameNavigated', sessionId: 'flat-session', params: { frame: { id: 'top', url: 'https://www.tiktok.com/@synthetic_user/live?secret=redacted' } } });
  assert.equal(h.connector.navigation.lastClassification, 'initial');
  socket.message({ method: 'Page.frameNavigated', sessionId: 'flat-session', params: { frame: { id: 'child', parentId: 'top', url: 'https://example.test/child' } } });
  assert.equal(h.connector.counters.pageNavigations, 1);
  socket.message({ method: 'Page.frameNavigated', sessionId: 'flat-session', params: { frame: { id: 'top', url: 'https://www.tiktok.com/@synthetic_user/live' } } });
  assert.equal(h.connector.navigation.lastClassification, 'site_navigation');
  assert.equal(h.connector.counters.pageNavigations, 2);
  assert.equal(h.connector.counters.targetRecoveries, 0);
  assert.equal(socket.sent.filter(({ method }) => method === 'Page.navigate').length, 1);
  assert.equal(socket.sent.filter(({ method }) => method === 'Fetch.enable').length, 1);
  assert.equal(JSON.stringify(h.diagnostics).includes('secret=redacted'), false);
  await h.connector.close(); assert.equal((await next).done, true);
});

test("connector becomes connected only after Webcast detection, accepts replacement, decodes, and cleans up", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected');
  assert.deepEqual(h.states.slice(0, 3), ['idle', 'connecting', 'connected']);
  const socket = h.sockets[0];
  assert.ok(socket.sent.findIndex(({ method }) => method === 'Fetch.enable') < socket.sent.findIndex(({ method }) => method === 'Page.navigate'));
  socket.message({ method: 'Fetch.requestPaused', sessionId: 'flat-session', params: { requestId: 'blocked-media', resourceType: 'Media', request: { url: 'https://cdn.test/live' } } });
  socket.message({ method: 'Fetch.requestPaused', sessionId: 'flat-session', params: { requestId: 'blocked-image', resourceType: 'Image', request: { url: 'https://cdn.test/avatar' } } });
  socket.message({ method: 'Fetch.requestPaused', sessionId: 'flat-session', params: { requestId: 'blocked-font', resourceType: 'Font', request: { url: 'https://cdn.test/font' } } });
  await until(() => h.connector.counters.blockedRequests === 3);
  assert.deepEqual({
    media: h.connector.counters.blockedMediaRequests,
    image: h.connector.counters.blockedImageRequests,
    font: h.connector.counters.blockedFontRequests,
  }, { media: 1, image: 1, font: 1 });
  assert.equal(Number.isSafeInteger(h.connector.counters.blockedRequests), true);
  socket.message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  assert.equal(h.connector.state, 'reconnecting');
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'flat-session', params: { requestId: 'webcast-2', url: 'wss://webcast-ws.eu.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/' } });
  assert.equal(h.connector.state, 'connected');
  socket.message({ method: 'Network.webSocketFrameReceived', sessionId: 'flat-session', params: { requestId: 'webcast-2', response: { opcode: 2, payloadData: Buffer.from([0xff, 0xff]).toString('base64') } } });
  assert.equal(h.timers.tasks.size, 0);
  const frame = encodeSyntheticWebcastFrame([{ method: 'WebcastChatMessage', data: { common: { createTime: 1 }, user: { uniqueId: 'viewer-2' }, content: 'synthetic hello' } }]);
  socket.message({ method: 'Network.webSocketFrameReceived', sessionId: 'flat-session', params: { requestId: 'webcast-2', response: { opcode: 2, payloadData: frame.toString('base64') } } });
  assert.equal((await next).value.data.content, 'synthetic hello');
  assert.equal(h.connector.counters.decodeFailures, 1);
  await h.connector.close();
  assert.equal((await iterator.next()).done, true);
  assert.equal(socket.sent.some(({ method }) => method === 'Target.closeTarget'), true);
  assert.equal(socket.sent.some(({ method }) => method === 'Browser.close'), false);
  assert.equal(socket.sent.some(({ method }) => method === 'Fetch.disable'), true);
  assert.equal(JSON.stringify(h.diagnostics).includes('private=value'), false);
  assert.equal([...socket.listeners.values()].every((handlers) => handlers.length === 0), true);
});

test("CDP loss enters bounded reconnect and close aborts the pending timer", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected'); h.sockets[0].close();
  await until(() => h.waits.length === 1);
  assert.equal(h.waits[0].delayMs, 10); assert.equal(h.connector.state, 'reconnecting');
  assert.equal(h.connector.counters.cdpDisconnects, 1);
  assert.equal(h.connector.recovery.lastReason, 'cdp_disconnected');
  h.waits[0].resolve(); await until(() => h.sockets.length === 2 && h.connector.state === 'connected');
  assert.deepEqual(h.sockets[1].sent.find(({ method }) => method === 'Target.createTarget').params, { url: 'about:blank', background: true, hidden: true });
  await h.connector.close(); assert.equal((await next).done, true);
});

test("shutdown clears replacement recovery and cannot create a late target", async () => {
  const h = connectorHarness({ replacementSocketTimeoutMs: 500 }); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected');
  h.sockets[0].message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  assert.equal(h.timers.tasks.size, 1);
  await h.connector.close(); h.timers.advance(5_000);
  assert.equal(h.timers.tasks.size, 0);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.connector.counters.targetCreations, 1);
  assert.equal((await next).done, true);
});

test("decoded connector event buffering is bounded and observable", async () => {
  const h = connectorHarness({ maxQueuedEvents: 2 }); const iterator = h.connector.events()[Symbol.asyncIterator]();
  const first = iterator.next(); await until(() => h.connector.state === 'connected');
  const messages = Array.from({ length: 4 }, (_, index) => ({ method: 'WebcastChatMessage', data: { user: { uniqueId: `viewer-${index}` }, content: `message-${index}` } }));
  const frame = encodeSyntheticWebcastFrame(messages);
  h.sockets[0].message({ method: 'Network.webSocketFrameReceived', sessionId: 'flat-session', params: { requestId: 'webcast-1', response: { opcode: 2, payloadData: frame.toString('base64') } } });
  assert.equal((await first).value.data.content, 'message-0');
  assert.equal(h.connector.counters.droppedEvents, 1);
  assert.equal((await iterator.next()).value.data.content, 'message-2');
  assert.equal((await iterator.next()).value.data.content, 'message-3');
  await h.connector.close(); assert.equal((await iterator.next()).done, true);
});
