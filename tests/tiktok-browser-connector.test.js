import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, TikTokBrowserConnector, binaryFrameFromCdp,
  closeOwnedTarget, createOwnedTarget, encodeSyntheticWebcastFrame, isTikTokWebcastSocket,
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
  assert.deepEqual(owned, { targetId: 'owned-page', sessionId: 'flat-session' });
  assert.deepEqual(calls.map(({ method }) => method), ['Target.createTarget', 'Target.attachToTarget', 'Network.enable', 'Page.enable', 'Page.navigate']);
  assert.equal(calls[4].params.url, 'https://www.tiktok.com/@synthetic_user/live');
  await closeOwnedTarget(client, owned.targetId);
  assert.equal(calls.at(-1).method, 'Target.closeTarget');
  assert.equal(calls.some(({ method }) => method === 'Browser.close'), false);
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

function connectorHarness({ maxQueuedEvents = DEFAULT_CONFIG.tiktokBrowser.maxQueuedEvents } = {}) {
  const sockets = []; const waits = []; const states = []; const diagnostics = [];
  const connector = new TikTokBrowserConnector({
    ...DEFAULT_CONFIG.tiktokBrowser, username: 'synthetic_user', maxQueuedEvents, navigationTimeoutMs: 1_000,
    webcastSocketTimeoutMs: 1_000, staleSocketTimeoutMs: 1_000,
    reconnect: { initialDelayMs: 10, maxDelayMs: 20, multiplier: 2, jitterRatio: 0 },
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/synthetic' }) }),
    webSocketFactory: () => { const socket = new AutoSocket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket; },
    sleep: (delayMs, signal) => new Promise((resolve) => { waits.push({ delayMs, resolve }); signal.addEventListener('abort', resolve, { once: true }); }),
    random: () => 0.5, onDiagnostic: (value) => diagnostics.push(value),
  });
  connector.subscribeState((state) => states.push(state));
  return { connector, sockets, waits, states, diagnostics };
}

test("connector becomes connected only after Webcast detection, accepts replacement, decodes, and cleans up", async () => {
  const h = connectorHarness(); const iterator = h.connector.events()[Symbol.asyncIterator](); const next = iterator.next();
  await until(() => h.connector.state === 'connected');
  assert.deepEqual(h.states.slice(0, 3), ['idle', 'connecting', 'connected']);
  const socket = h.sockets[0];
  assert.ok(socket.sent.findIndex(({ method }) => method === 'Fetch.enable') < socket.sent.findIndex(({ method }) => method === 'Page.navigate'));
  socket.message({ method: 'Network.webSocketClosed', sessionId: 'flat-session', params: { requestId: 'webcast-1' } });
  assert.equal(h.connector.state, 'reconnecting');
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'flat-session', params: { requestId: 'webcast-2', url: 'wss://webcast-ws.eu.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/' } });
  assert.equal(h.connector.state, 'connected');
  socket.message({ method: 'Network.webSocketFrameReceived', sessionId: 'flat-session', params: { requestId: 'webcast-2', response: { opcode: 2, payloadData: Buffer.from([0xff, 0xff]).toString('base64') } } });
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
  await h.connector.close(); assert.equal((await next).done, true);
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
