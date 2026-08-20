import { abortableDelay } from "../tikfinity-connector.js";
import { CdpClient, discoverBrowserWebSocket, sanitizedUrl, validateCdpUrl, waitForWebSocketOpen } from "./cdp-client.js";
import { decodeWebcastFrame } from "./webcast-decoder.js";
import { installTikTokMediaBlocker } from "./media-blocker.js";
const MAX_SELECTED_SOCKETS = 8;

export function normalizeTikTokUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,24}$/.test(username) ? username : null;
}

export function isTikTokWebcastSocket(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'wss:'
      && (host === 'tiktok.com' || host.endsWith('.tiktok.com'))
      && url.pathname.startsWith('/webcast/im/');
  } catch { return false; }
}

export function binaryFrameFromCdp(params, selectedRequestIds) {
  if (!selectedRequestIds.has(params.requestId) || params.response?.opcode !== 2 || typeof params.response.payloadData !== 'string') return null;
  return Buffer.from(params.response.payloadData, 'base64');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:https?|wss?):\/\/\S+/giu, '[redacted-url]').replace(/[\r\n\t]/gu, ' ').slice(0, 240);
}

class AsyncChannel {
  #items = [];
  #waiters = [];
  #closed = false;
  #maximum;
  #onDrop;
  constructor(maximum, onDrop) { this.#maximum = maximum; this.#onDrop = onDrop; }
  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value });
    else {
      if (this.#items.length >= this.#maximum) { this.#items.shift(); this.#onDrop(); }
      this.#items.push(value);
    }
  }
  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, error });
  }
  next() {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift() });
    if (this.#closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function withTimeout(operation, timeoutMs, signal, message) {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const operationController = new AbortController();
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; cleanup(); callback(value); };
    const timer = setTimeout(() => { operationController.abort(); finish(reject, new Error(message)); }, timeoutMs);
    const onAbort = () => { operationController.abort(); finish(reject, new DOMException('aborted', 'AbortError')); };
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => operation(operationController.signal)).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export async function createOwnedTarget(client, { username, signal, navigate = true }) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' }, { signal });
  let sessionId;
  try {
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }, { signal }));
    await client.send('Network.enable', {}, { sessionId, signal });
    await client.send('Page.enable', {}, { sessionId, signal });
    if (navigate) await navigateOwnedTarget(client, { username, sessionId, signal });
    return { targetId, sessionId };
  } catch (error) {
    try { await client.send('Target.closeTarget', { targetId }); } catch {}
    throw error;
  }
}

export async function navigateOwnedTarget(client, { username, sessionId, signal }) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
  const navigation = await client.send('Page.navigate', { url }, { sessionId, signal });
  if (navigation.errorText) throw new Error(`TikTok LIVE navigation failed: ${navigation.errorText}`);
}

export async function closeOwnedTarget(client, targetId) {
  if (!client || !targetId || client.closed) return;
  try { await client.send('Target.closeTarget', { targetId }, { signal: AbortSignal.timeout(1_000) }); } catch { /* target/browser already gone */ }
}

export class TikTokBrowserConnector {
  name = 'tiktok-browser';
  #config;
  #state = 'idle';
  #subscribers = [];
  #active = false;
  #stopController;
  #client;
  #targetId;
  #sessionCleanup;
  #webSocketFactory;
  #fetch;
  #sleep;
  #random;
  #decode;
  #diagnostic;
  #counters = { blockedMediaRequests: 0, webcastFrames: 0, webcastBytes: 0, decodedEvents: 0, decodeFailures: 0, droppedEvents: 0 };

  constructor({ username, cdpUrl, navigationTimeoutMs, webcastSocketTimeoutMs, staleSocketTimeoutMs, maxQueuedEvents, blockMedia,
    reconnect, webSocketFactory = (url) => new WebSocket(url), fetchImpl = globalThis.fetch,
    sleep = abortableDelay, random = Math.random, decode = decodeWebcastFrame, onDiagnostic = () => {} }) {
    const normalized = normalizeTikTokUsername(username);
    if (!normalized) throw new TypeError('TikTok browser username must be 2-24 letters, numbers, dots, or underscores');
    validateCdpUrl(cdpUrl);
    for (const [name, value] of Object.entries({ navigationTimeoutMs, webcastSocketTimeoutMs, staleSocketTimeoutMs, maxQueuedEvents })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
    }
    if (typeof blockMedia !== 'boolean') throw new TypeError('blockMedia must be boolean');
    if (!reconnect || !Number.isSafeInteger(reconnect.initialDelayMs) || reconnect.initialDelayMs < 1
      || !Number.isSafeInteger(reconnect.maxDelayMs) || reconnect.maxDelayMs < reconnect.initialDelayMs
      || !Number.isFinite(reconnect.multiplier) || reconnect.multiplier < 1
      || !Number.isFinite(reconnect.jitterRatio) || reconnect.jitterRatio < 0 || reconnect.jitterRatio > 1) {
      throw new TypeError('Invalid TikTok browser reconnect configuration');
    }
    this.#config = { username: normalized, cdpUrl, navigationTimeoutMs, webcastSocketTimeoutMs, staleSocketTimeoutMs, maxQueuedEvents, blockMedia, reconnect: { ...reconnect } };
    this.#webSocketFactory = webSocketFactory; this.#fetch = fetchImpl; this.#sleep = sleep; this.#random = random;
    this.#decode = decode; this.#diagnostic = onDiagnostic;
  }

  get state() { return this.#state; }
  get counters() { return { ...this.#counters }; }

  subscribeState(handler) {
    if (typeof handler !== 'function') throw new TypeError('State subscriber must be a function');
    this.#subscribers.push(handler); handler(this.#state);
    return () => { this.#subscribers = this.#subscribers.filter((candidate) => candidate !== handler); };
  }

  async close() {
    this.#stopController?.abort();
    await this.#sessionCleanup?.();
    const targetId = this.#targetId;
    this.#targetId = undefined;
    const client = this.#client;
    await closeOwnedTarget(client, targetId);
    client?.close();
    if (this.#client === client) this.#client = undefined;
    this.#transition('disconnected');
  }

  async *events(signal) {
    if (this.#active) throw new Error('TikTokBrowserConnector already has an active event stream');
    this.#active = true; this.#stopController = new AbortController();
    const lifecycleSignal = this.#stopController.signal;
    const onAbort = () => this.#stopController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let delayBase = this.#config.reconnect.initialDelayMs;
    let attempt = 0;
    try {
      while (!lifecycleSignal.aborted) {
        attempt += 1;
        this.#transition(attempt === 1 ? 'connecting' : 'reconnecting');
        this.#emitDiagnostic({ code: 'tiktok_browser.cdp_connecting', endpoint: sanitizedUrl(this.#config.cdpUrl), attempt });
        const channel = new AsyncChannel(this.#config.maxQueuedEvents, () => {
          this.#counters.droppedEvents += 1;
          if (this.#counters.droppedEvents <= 5 || this.#counters.droppedEvents % 100 === 0) this.#emitDiagnostic({ code: 'tiktok_browser.event_queue_overflow', droppedEvents: this.#counters.droppedEvents });
        });
        let cleanup = async () => {};
        try {
          cleanup = await this.#openSession(channel, lifecycleSignal);
          delayBase = this.#config.reconnect.initialDelayMs;
          while (!lifecycleSignal.aborted) {
            const item = await channel.next();
            if (item.done) throw item.error ?? new Error('TikTok browser session ended');
            yield item.value;
          }
        } catch (error) {
          if (lifecycleSignal.aborted) break;
          this.#transition('error');
          const message = errorMessage(error);
          const code = message.includes('Webcast socket did not appear') ? 'tiktok_browser.webcast_timeout'
            : message.includes('navigation') ? 'tiktok_browser.navigation_failed' : 'tiktok_browser.cdp_failed';
          this.#emitDiagnostic({ code, attempt, error: message });
        } finally {
          await cleanup();
          const targetId = this.#targetId;
          this.#targetId = undefined;
          const client = this.#client;
          await closeOwnedTarget(client, targetId);
          client?.close();
          if (this.#client === client) this.#client = undefined;
        }
        if (lifecycleSignal.aborted) break;
        const spread = this.#random() * 2 - 1;
        const delayMs = Math.round(Math.min(this.#config.reconnect.maxDelayMs, Math.max(1, delayBase * (1 + spread * this.#config.reconnect.jitterRatio))));
        this.#transition('reconnecting');
        this.#emitDiagnostic({ code: 'tiktok_browser.reconnecting', attempt, delayMs });
        await this.#sleep(delayMs, lifecycleSignal);
        delayBase = Math.min(this.#config.reconnect.maxDelayMs, delayBase * this.#config.reconnect.multiplier);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort); this.#active = false; this.#transition('disconnected');
      this.#emitDiagnostic({ code: 'tiktok_browser.disconnected', counters: this.counters });
    }
  }

  async #openSession(channel, signal) {
    const endpoint = await withTimeout((operationSignal) => discoverBrowserWebSocket(this.#config.cdpUrl, { fetchImpl: this.#fetch, signal: operationSignal }), this.#config.navigationTimeoutMs, signal, 'CDP discovery timed out');
    const socket = this.#webSocketFactory(endpoint);
    try {
      await withTimeout((operationSignal) => waitForWebSocketOpen(socket, operationSignal), this.#config.navigationTimeoutMs, signal, 'CDP WebSocket timed out');
    } catch (error) {
      try { socket.close(); } catch {}
      throw error;
    }
    const client = new CdpClient(socket, {
      onDiagnostic: (value) => this.#emitDiagnostic(value),
      allowedEventMethods: [
        'Network.webSocketCreated', 'Network.webSocketClosed', 'Network.webSocketFrameReceived',
        'Fetch.requestPaused', 'Target.targetCrashed', 'Target.targetDestroyed', 'Target.detachedFromTarget',
      ],
    });
    this.#client = client;
    this.#emitDiagnostic({ code: 'tiktok_browser.cdp_connected' });
    const owned = await withTimeout((operationSignal) => createOwnedTarget(client, { ...this.#config, signal: operationSignal, navigate: false }), this.#config.navigationTimeoutMs, signal, 'TikTok page setup timed out');
    this.#targetId = owned.targetId;
    this.#emitDiagnostic({ code: 'tiktok_browser.page_created' });
    const stopMediaBlocker = this.#config.blockMedia
      ? await installTikTokMediaBlocker(client, {
        sessionId: owned.sessionId,
        signal,
        onBlocked: () => { this.#counters.blockedMediaRequests += 1; },
        onDiagnostic: (value) => this.#emitDiagnostic(value),
      })
      : async () => {};
    const selected = new Set();
    const socketSeen = deferred();
    let connected = false;
    let staleTimer;
    const resetStale = () => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!signal.aborted) { this.#transition('reconnecting'); channel.close(new Error('Webcast socket became stale')); }
      }, this.#config.staleSocketTimeoutMs);
    };
    const off = [
      client.subscribe('Network.webSocketCreated', ({ requestId, url }) => {
        if (!isTikTokWebcastSocket(url)) return;
        if (selected.size >= MAX_SELECTED_SOCKETS) selected.delete(selected.values().next().value);
        selected.add(requestId); connected = true; socketSeen.resolve(); resetStale();
        this.#transition('connected'); this.#emitDiagnostic({ code: 'tiktok_browser.webcast_connected', endpoint: sanitizedUrl(url) });
      }, { sessionId: owned.sessionId }),
      client.subscribe('Network.webSocketClosed', ({ requestId }) => {
        if (!selected.delete(requestId)) return;
        if (selected.size === 0) { connected = false; this.#transition('reconnecting'); this.#emitDiagnostic({ code: 'tiktok_browser.webcast_disconnected' }); resetStale(); }
      }, { sessionId: owned.sessionId }),
      client.subscribe('Network.webSocketFrameReceived', (params) => {
        const bytes = binaryFrameFromCdp(params, selected); if (!bytes) return;
        resetStale(); this.#counters.webcastFrames += 1; this.#counters.webcastBytes += bytes.byteLength;
        try {
          const decoded = this.#decode(bytes); this.#counters.decodedEvents += decoded.length;
          for (const event of decoded) if (!signal.aborted) channel.push(event);
        } catch (error) {
          this.#counters.decodeFailures += 1;
          if (this.#counters.decodeFailures <= 5 || this.#counters.decodeFailures % 100 === 0) this.#emitDiagnostic({ code: 'tiktok_browser.frame_decode_failed', failures: this.#counters.decodeFailures, error: errorMessage(error) });
        }
      }, { sessionId: owned.sessionId }),
      client.subscribe('Target.targetCrashed', ({ targetId }) => { if (targetId === owned.targetId) channel.close(new Error('Owned TikTok page crashed')); }),
      client.subscribe('Target.targetDestroyed', ({ targetId }) => { if (targetId === owned.targetId) channel.close(new Error('Owned TikTok page closed')); }),
      client.subscribe('Target.detachedFromTarget', ({ targetId, sessionId }) => { if (targetId === owned.targetId || sessionId === owned.sessionId) channel.close(new Error('Owned TikTok page detached')); }),
    ];
    void client.disconnected.then((error) => channel.close(error));
    this.#emitDiagnostic({ code: 'tiktok_browser.webcast_waiting' });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(staleTimer);
      for (const unsubscribe of off) unsubscribe();
      await stopMediaBlocker();
      if (connected) selected.clear();
      channel.close();
      if (this.#sessionCleanup === cleanup) this.#sessionCleanup = undefined;
    };
    this.#sessionCleanup = cleanup;
    try {
      await withTimeout((operationSignal) => navigateOwnedTarget(client, { username: this.#config.username, sessionId: owned.sessionId, signal: operationSignal }), this.#config.navigationTimeoutMs, signal, 'TikTok navigation timed out');
      await withTimeout(() => socketSeen.promise, this.#config.webcastSocketTimeoutMs, signal, 'TikTok Webcast socket did not appear');
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  #transition(state) {
    if (state === this.#state) return;
    this.#state = state;
    for (const handler of [...this.#subscribers]) {
      try { handler(state); } catch (error) {
        this.#emitDiagnostic({ code: 'tiktok_browser.state_subscriber_failed', error: errorMessage(error) });
      }
    }
  }
  #emitDiagnostic(value) { try { this.#diagnostic(value); } catch {} }
}
