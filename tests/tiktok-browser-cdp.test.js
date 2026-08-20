import test from "node:test";
import assert from "node:assert/strict";
import { CdpClient, CdpProtocolError, discoverBrowserWebSocket, validateCdpUrl } from "../src/index.js";

class FakeSocket {
  listeners = new Map(); sent = []; readyState = 1; closeCalls = 0;
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler)); }
  send(data) { this.sent.push(JSON.parse(data)); }
  emit(type, value = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(value); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
  close() { this.closeCalls += 1; this.emit('close'); }
}

test("CDP URL validation accepts loopback only and rejects credentials", () => {
  for (const value of ['http://localhost:9222', 'http://127.0.0.1:9222', 'http://[::1]:9222']) assert.doesNotThrow(() => validateCdpUrl(value));
  for (const value of ['http://192.168.1.2:9222', 'https://example.com', 'http://user:pass@localhost:9222']) assert.throws(() => validateCdpUrl(value));
});

test("CDP discovery fetches only local version metadata and validates returned socket", async () => {
  let requested;
  const endpoint = await discoverBrowserWebSocket('http://localhost:9222', { fetchImpl: async (url) => {
    requested = url.href; return { ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/synthetic' }) };
  } });
  assert.equal(requested, 'http://localhost:9222/json/version');
  assert.equal(endpoint, 'ws://127.0.0.1:9222/devtools/browser/synthetic');
  await assert.rejects(discoverBrowserWebSocket('http://localhost:9222', { fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ webSocketDebuggerUrl: 'ws://public.invalid/devtools/browser/x' }) }) }));
});

test("CDP commands correlate results, structured errors, abort, and socket loss", async () => {
  const socket = new FakeSocket(); const client = new CdpClient(socket);
  const first = client.send('Page.enable', {}, { sessionId: 'session-a' });
  assert.equal(socket.sent[0].sessionId, 'session-a');
  socket.message({ id: socket.sent[0].id, result: { enabled: true } });
  assert.deepEqual(await first, { enabled: true });

  const failure = client.send('Page.navigate');
  socket.message({ id: socket.sent[1].id, error: { code: -32000, message: 'bad navigation' } });
  await assert.rejects(failure, (error) => error instanceof CdpProtocolError && error.code === -32000);

  const controller = new AbortController(); const aborted = client.send('Network.enable', {}, { signal: controller.signal });
  controller.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  const pending = client.send('Runtime.enable'); socket.emit('close');
  await assert.rejects(pending, /closed/);
});

test("CDP flattened session events route to matching and global subscribers", () => {
  const socket = new FakeSocket(); const client = new CdpClient(socket); const calls = [];
  client.subscribe('Network.webSocketCreated', () => calls.push('session'), { sessionId: 'one' });
  client.subscribe('Network.webSocketCreated', () => calls.push('global'));
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'one', params: {} });
  socket.message({ method: 'Network.webSocketCreated', sessionId: 'two', params: {} });
  assert.deepEqual(calls, ['session', 'global', 'global']);
});
