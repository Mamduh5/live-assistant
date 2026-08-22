import { abortableDelay } from "../tikfinity-connector.js";
import { CdpClient, CdpProtocolError, discoverBrowserWebSocket, sanitizedUrl, validateCdpUrl, waitForWebSocketOpen } from "./cdp-client.js";
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

function boundedIncrement(value, amount = 1) {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

const SAFE_TARGET_MODES = Object.freeze([
  Object.freeze({ name: 'hidden', params: Object.freeze({ url: 'about:blank', background: true, hidden: true }) }),
  Object.freeze({ name: 'background_unfocused', params: Object.freeze({ url: 'about:blank', background: true, focus: false }) }),
  Object.freeze({ name: 'background', params: Object.freeze({ url: 'about:blank', background: true }) }),
]);

function isUnsupportedTargetOption(error) {
  return error instanceof CdpProtocolError && (error.code === -32602
    || /invalid parameters?|unknown (?:parameter|property)|unexpected (?:parameter|property)|not (?:found|supported)/iu.test(error.message));
}

export async function createSafeBackgroundTarget(client, { signal, onFallback = () => {} } = {}) {
  let previousError;
  for (const mode of SAFE_TARGET_MODES) {
    try {
      const { targetId } = await client.send('Target.createTarget', { ...mode.params }, { signal });
      if (typeof targetId !== 'string' || targetId.length === 0) throw new Error('Chrome omitted the safely created target identifier');
      return { targetId, mode: mode.name };
    } catch (error) {
      previousError = error;
      if (!isUnsupportedTargetOption(error)) throw error;
      onFallback({ rejectedMode: mode.name });
    }
  }
  throw new Error(`Chrome does not support safe background target creation: ${errorMessage(previousError)}`);
}

class AsyncChannel {
  #items = [];
  #waiters = [];
  #closed = false;
  #error;
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
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, error });
  }
  next() {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift() });
    if (this.#closed) return Promise.resolve({ done: true, error: this.#error });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class SessionRecoveryError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SessionRecoveryError';
    this.recoveryReason = reason;
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

export async function createOwnedTarget(client, { username, signal, navigate = true, onTargetCreated, onTargetFallback }) {
  const { targetId, mode } = await createSafeBackgroundTarget(client, { signal, onFallback: onTargetFallback });
  onTargetCreated?.({ targetId, mode });
  let sessionId;
  try {
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }, { signal }));
    await client.send('Network.enable', {}, { sessionId, signal });
    await client.send('Page.enable', {}, { sessionId, signal });
    if (navigate) await navigateOwnedTarget(client, { username, sessionId, signal });
    return { targetId, sessionId, mode };
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
  #setTimer;
  #clearTimer;
  #recovery = { lastReason: null };
  #navigation = { lastClassification: null };
  #counters = {
    blockedRequests: 0, blockedMediaRequests: 0, blockedImageRequests: 0, blockedFontRequests: 0,
    webcastFrames: 0, webcastBytes: 0, decodedEvents: 0, decodeFailures: 0, droppedEvents: 0,
    targetCreations: 0, targetRecoveries: 0, applicationNavigations: 0, pageNavigations: 0,
    webcastSocketCreated: 0, webcastSocketClosed: 0, replacementSocketTimeouts: 0,
    cdpDisconnects: 0, targetCrashes: 0, targetDestroyed: 0, targetDetached: 0,
  };

  constructor({ username, cdpUrl, navigationTimeoutMs, webcastSocketTimeoutMs, replacementSocketTimeoutMs, maxQueuedEvents, blockMedia,
    reconnect, webSocketFactory = (url) => new WebSocket(url), fetchImpl = globalThis.fetch,
    sleep = abortableDelay, random = Math.random, decode = decodeWebcastFrame, onDiagnostic = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    const normalized = normalizeTikTokUsername(username);
    if (!normalized) throw new TypeError('TikTok browser username must be 2-24 letters, numbers, dots, or underscores');
    validateCdpUrl(cdpUrl);
    for (const [name, value] of Object.entries({ navigationTimeoutMs, webcastSocketTimeoutMs, replacementSocketTimeoutMs, maxQueuedEvents })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
    }
    if (typeof blockMedia !== 'boolean') throw new TypeError('blockMedia must be boolean');
    if (!reconnect || !Number.isSafeInteger(reconnect.initialDelayMs) || reconnect.initialDelayMs < 1
      || !Number.isSafeInteger(reconnect.maxDelayMs) || reconnect.maxDelayMs < reconnect.initialDelayMs
      || !Number.isFinite(reconnect.multiplier) || reconnect.multiplier < 1
      || !Number.isFinite(reconnect.jitterRatio) || reconnect.jitterRatio < 0 || reconnect.jitterRatio > 1) {
      throw new TypeError('Invalid TikTok browser reconnect configuration');
    }
    this.#config = { username: normalized, cdpUrl, navigationTimeoutMs, webcastSocketTimeoutMs, replacementSocketTimeoutMs, maxQueuedEvents, blockMedia, reconnect: { ...reconnect } };
    this.#webSocketFactory = webSocketFactory; this.#fetch = fetchImpl; this.#sleep = sleep; this.#random = random;
    this.#decode = decode; this.#diagnostic = onDiagnostic;
    this.#setTimer = setTimer; this.#clearTimer = clearTimer;
  }

  get state() { return this.#state; }
  get counters() { return { ...this.#counters }; }
  get recovery() { return { ...this.#recovery }; }
  get navigation() { return { ...this.#navigation }; }

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
    let recoveryReason = 'initial_start';
    try {
      while (!lifecycleSignal.aborted) {
        attempt += 1;
        this.#recovery.lastReason = recoveryReason;
        if (attempt > 1) this.#counters.targetRecoveries = boundedIncrement(this.#counters.targetRecoveries);
        this.#transition(attempt === 1 ? 'connecting' : 'reconnecting');
        this.#emitDiagnostic({ code: 'tiktok_browser.cdp_connecting', endpoint: sanitizedUrl(this.#config.cdpUrl), attempt, recoveryReason });
        const channel = new AsyncChannel(this.#config.maxQueuedEvents, () => {
          this.#counters.droppedEvents = boundedIncrement(this.#counters.droppedEvents);
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
          recoveryReason = error?.recoveryReason ?? (errorMessage(error).includes('Webcast socket did not appear') ? 'initial_socket_timeout' : 'session_failed');
          this.#recovery.lastReason = recoveryReason;
          this.#transition('error');
          const message = errorMessage(error);
          const code = message.includes('Webcast socket did not appear') ? 'tiktok_browser.webcast_timeout'
            : message.includes('navigation') ? 'tiktok_browser.navigation_failed' : 'tiktok_browser.cdp_failed';
          this.#emitDiagnostic({ code, attempt, recoveryReason, error: message });
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
    let endpoint;
    try {
      endpoint = await withTimeout((operationSignal) => discoverBrowserWebSocket(this.#config.cdpUrl, { fetchImpl: this.#fetch, signal: operationSignal }), this.#config.navigationTimeoutMs, signal, 'CDP discovery timed out');
    } catch (error) {
      throw new SessionRecoveryError('cdp_discovery_failed', errorMessage(error));
    }
    const socket = this.#webSocketFactory(endpoint);
    try {
      await withTimeout((operationSignal) => waitForWebSocketOpen(socket, operationSignal), this.#config.navigationTimeoutMs, signal, 'CDP WebSocket timed out');
    } catch (error) {
      try { socket.close(); } catch {}
      throw new SessionRecoveryError('cdp_connection_failed', errorMessage(error));
    }
    const client = new CdpClient(socket, {
      onDiagnostic: (value) => this.#emitDiagnostic(value),
      allowedEventMethods: [
        'Network.webSocketCreated', 'Network.webSocketClosed', 'Network.webSocketFrameReceived',
        'Fetch.requestPaused', 'Target.targetCrashed', 'Target.targetDestroyed', 'Target.detachedFromTarget',
        'Page.frameNavigated',
      ],
    });
    this.#client = client;
    this.#emitDiagnostic({ code: 'tiktok_browser.cdp_connected' });
    let owned;
    try {
      owned = await withTimeout((operationSignal) => createOwnedTarget(client, {
        ...this.#config,
        signal: operationSignal,
        navigate: false,
        onTargetCreated: ({ mode }) => {
          this.#counters.targetCreations = boundedIncrement(this.#counters.targetCreations);
          this.#emitDiagnostic({ code: 'tiktok_browser.page_created', targetMode: mode });
        },
        onTargetFallback: ({ rejectedMode }) => this.#emitDiagnostic({ code: 'tiktok_browser.safe_target_mode_unsupported', rejectedMode }),
      }), this.#config.navigationTimeoutMs, signal, 'TikTok page setup timed out');
    } catch (error) {
      throw new SessionRecoveryError('target_setup_failed', errorMessage(error));
    }
    this.#targetId = owned.targetId;
    const stopMediaBlocker = this.#config.blockMedia
      ? await installTikTokMediaBlocker(client, {
        sessionId: owned.sessionId,
        signal,
        onBlocked: (category) => {
          this.#counters.blockedRequests = boundedIncrement(this.#counters.blockedRequests);
          const field = category === 'image' ? 'blockedImageRequests' : category === 'font' ? 'blockedFontRequests' : 'blockedMediaRequests';
          this.#counters[field] = boundedIncrement(this.#counters[field]);
        },
        onDiagnostic: (value) => this.#emitDiagnostic(value),
      })
      : async () => {};
    const selected = new Set();
    const socketSeen = deferred();
    let pendingApplicationNavigation = this.#counters.targetRecoveries > 0 ? 'application_recovery' : 'initial';
    let sessionClosed = false;
    let replacementTimer;
    const clearReplacementTimer = () => {
      if (replacementTimer === undefined) return;
      this.#clearTimer(replacementTimer);
      replacementTimer = undefined;
    };
    const waitForReplacement = () => {
      clearReplacementTimer();
      replacementTimer = this.#setTimer(() => {
        replacementTimer = undefined;
        if (!signal.aborted && selected.size === 0) {
          this.#counters.replacementSocketTimeouts = boundedIncrement(this.#counters.replacementSocketTimeouts);
          channel.close(new SessionRecoveryError('replacement_timeout', 'Webcast replacement socket did not appear'));
        }
      }, this.#config.replacementSocketTimeoutMs);
    };
    const off = [
      client.subscribe('Network.webSocketCreated', ({ requestId, url }) => {
        if (!isTikTokWebcastSocket(url)) return;
        if (selected.size >= MAX_SELECTED_SOCKETS) selected.delete(selected.values().next().value);
        selected.add(requestId); clearReplacementTimer(); socketSeen.resolve();
        this.#counters.webcastSocketCreated = boundedIncrement(this.#counters.webcastSocketCreated);
        this.#transition('connected'); this.#emitDiagnostic({ code: 'tiktok_browser.webcast_connected', endpoint: sanitizedUrl(url) });
      }, { sessionId: owned.sessionId }),
      client.subscribe('Network.webSocketClosed', ({ requestId }) => {
        if (!selected.delete(requestId)) return;
        this.#counters.webcastSocketClosed = boundedIncrement(this.#counters.webcastSocketClosed);
        if (selected.size === 0) {
          this.#transition('reconnecting');
          this.#emitDiagnostic({ code: 'tiktok_browser.webcast_disconnected', replacementTimeoutMs: this.#config.replacementSocketTimeoutMs });
          waitForReplacement();
        }
      }, { sessionId: owned.sessionId }),
      client.subscribe('Page.frameNavigated', ({ frame }) => {
        if (!frame || frame.parentId) return;
        this.#counters.pageNavigations = boundedIncrement(this.#counters.pageNavigations);
        const classification = pendingApplicationNavigation ?? 'site_navigation';
        pendingApplicationNavigation = null;
        this.#navigation.lastClassification = classification;
        this.#emitDiagnostic({ code: 'tiktok_browser.page_navigated', classification });
      }, { sessionId: owned.sessionId }),
      client.subscribe('Network.webSocketFrameReceived', (params) => {
        const bytes = binaryFrameFromCdp(params, selected); if (!bytes) return;
        this.#counters.webcastFrames = boundedIncrement(this.#counters.webcastFrames);
        this.#counters.webcastBytes = boundedIncrement(this.#counters.webcastBytes, bytes.byteLength);
        try {
          const decoded = this.#decode(bytes); this.#counters.decodedEvents = boundedIncrement(this.#counters.decodedEvents, decoded.length);
          for (const event of decoded) if (!signal.aborted) channel.push(event);
        } catch (error) {
          this.#counters.decodeFailures = boundedIncrement(this.#counters.decodeFailures);
          if (this.#counters.decodeFailures <= 5 || this.#counters.decodeFailures % 100 === 0) this.#emitDiagnostic({ code: 'tiktok_browser.frame_decode_failed', failures: this.#counters.decodeFailures, error: errorMessage(error) });
        }
      }, { sessionId: owned.sessionId }),
      client.subscribe('Target.targetCrashed', ({ targetId }) => {
        if (targetId !== owned.targetId) return;
        this.#counters.targetCrashes = boundedIncrement(this.#counters.targetCrashes);
        channel.close(new SessionRecoveryError('target_crashed', 'Owned TikTok page crashed'));
      }),
      client.subscribe('Target.targetDestroyed', ({ targetId }) => {
        if (targetId !== owned.targetId) return;
        this.#counters.targetDestroyed = boundedIncrement(this.#counters.targetDestroyed);
        channel.close(new SessionRecoveryError('target_destroyed', 'Owned TikTok page closed'));
      }),
      client.subscribe('Target.detachedFromTarget', ({ targetId, sessionId }) => {
        if (targetId !== owned.targetId && sessionId !== owned.sessionId) return;
        this.#counters.targetDetached = boundedIncrement(this.#counters.targetDetached);
        channel.close(new SessionRecoveryError('target_detached', 'Owned TikTok page detached'));
      }),
    ];
    void client.disconnected.then(() => {
      if (sessionClosed || signal.aborted) return;
      this.#counters.cdpDisconnects = boundedIncrement(this.#counters.cdpDisconnects);
      channel.close(new SessionRecoveryError('cdp_disconnected', 'CDP WebSocket disconnected'));
    });
    this.#emitDiagnostic({ code: 'tiktok_browser.webcast_waiting' });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      sessionClosed = true;
      clearReplacementTimer();
      for (const unsubscribe of off) unsubscribe();
      await stopMediaBlocker();
      selected.clear();
      channel.close();
      if (this.#sessionCleanup === cleanup) this.#sessionCleanup = undefined;
    };
    this.#sessionCleanup = cleanup;
    try {
      this.#counters.applicationNavigations = boundedIncrement(this.#counters.applicationNavigations);
      try {
        await withTimeout((operationSignal) => navigateOwnedTarget(client, { username: this.#config.username, sessionId: owned.sessionId, signal: operationSignal }), this.#config.navigationTimeoutMs, signal, 'TikTok navigation timed out');
      } catch (error) {
        throw new SessionRecoveryError('navigation_failed', errorMessage(error));
      }
      try {
        await withTimeout(() => socketSeen.promise, this.#config.webcastSocketTimeoutMs, signal, 'TikTok Webcast socket did not appear');
      } catch (error) {
        throw new SessionRecoveryError('initial_socket_timeout', errorMessage(error));
      }
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
