function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class CdpProtocolError extends Error {
  constructor(method, protocolError) {
    super(`CDP command ${method} failed: ${protocolError?.message ?? "Unknown protocol error"}`);
    this.name = "CdpProtocolError";
    this.method = method;
    this.code = protocolError?.code;
  }
}

export function validateCdpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("TikTok browser CDP URL must be a valid URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError("TikTok browser CDP URL must use http: or https:");
  if (parsed.username || parsed.password) throw new TypeError("TikTok browser CDP URL must not contain credentials");
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new TypeError("TikTok browser CDP URL must use a loopback host");
  }
  return parsed;
}

export function sanitizedUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export async function discoverBrowserWebSocket(cdpUrl, {
  fetchImpl = globalThis.fetch,
  signal,
  maxResponseBytes = 65_536,
} = {}) {
  const base = validateCdpUrl(cdpUrl);
  const response = await fetchImpl(new URL('/json/version', base), { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Chrome CDP discovery failed with HTTP ${response.status}`);
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxResponseBytes) { await reader.cancel(); throw new Error("Chrome CDP discovery response exceeded the size limit"); }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((value) => Buffer.from(value)), length).toString('utf8');
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("Chrome CDP discovery response exceeded the size limit");
  }
  const data = JSON.parse(text);
  if (!data || typeof data.webSocketDebuggerUrl !== 'string') throw new Error("Chrome CDP discovery response omitted webSocketDebuggerUrl");
  const endpoint = new URL(data.webSocketDebuggerUrl);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error("Chrome returned an invalid debugger WebSocket URL");
  const endpointHost = endpoint.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpointHost)) throw new Error("Chrome returned a non-loopback debugger WebSocket URL");
  return endpoint.href;
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #subscribers = new Map();
  #closed = false;
  #onDiagnostic;
  #listeners;
  #disconnected;
  #resolveDisconnected;
  #allowedEventMethods;
  #maxMessageBytes;

  constructor(socket, { onDiagnostic = () => {}, allowedEventMethods, maxMessageBytes = 12 * 1024 * 1024 } = {}) {
    if (!socket || typeof socket.addEventListener !== 'function' || typeof socket.send !== 'function') {
      throw new TypeError("CDP client requires a WebSocket-compatible object");
    }
    this.#socket = socket;
    this.#onDiagnostic = onDiagnostic;
    this.#allowedEventMethods = allowedEventMethods ? new Set(allowedEventMethods) : null;
    this.#maxMessageBytes = maxMessageBytes;
    this.#disconnected = new Promise((resolve) => { this.#resolveDisconnected = resolve; });
    this.#listeners = {
      message: (event) => this.#onMessage(event.data),
      close: () => this.#disconnect(new Error("CDP WebSocket closed")),
      error: (event) => this.#disconnect(event.error ?? new Error("CDP WebSocket failed")),
    };
    for (const [type, handler] of Object.entries(this.#listeners)) socket.addEventListener(type, handler);
  }

  get closed() { return this.#closed; }
  get disconnected() { return this.#disconnected; }

  send(method, params = {}, { sessionId, signal } = {}) {
    if (this.#closed) return Promise.reject(new Error("CDP client is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, method, signal, onAbort });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.#settle(id, 'reject', error);
      }
    });
  }

  subscribe(method, handler, { sessionId } = {}) {
    if (typeof handler !== 'function') throw new TypeError("CDP event subscriber must be a function");
    const key = `${sessionId ?? ''}\n${method}`;
    const handlers = this.#subscribers.get(key) ?? [];
    handlers.push(handler);
    this.#subscribers.set(key, handlers);
    return () => {
      const current = this.#subscribers.get(key) ?? [];
      const remaining = current.filter((candidate) => candidate !== handler);
      if (remaining.length) this.#subscribers.set(key, remaining);
      else this.#subscribers.delete(key);
    };
  }

  close() {
    if (this.#closed) return;
    this.#disconnect(new Error("CDP client closed"));
    try { this.#socket.close(); } catch { /* already closed */ }
  }

  #onMessage(data) {
    if (typeof data !== 'string') return;
    if (Buffer.byteLength(data) > this.#maxMessageBytes) {
      this.#diagnostic({ code: 'tiktok_browser.cdp_message_too_large' });
      return;
    }
    if (this.#allowedEventMethods && !/^\s*\{\s*"id"\s*:/u.test(data)) {
      const method = /"method"\s*:\s*"([^"]+)"/u.exec(data)?.[1];
      if (!method || !this.#allowedEventMethods.has(method)) return;
    }
    let message;
    try { message = JSON.parse(data); } catch {
      this.#diagnostic({ code: 'tiktok_browser.cdp_invalid_message' });
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      if (message.error) this.#settle(message.id, 'reject', new CdpProtocolError(this.#pending.get(message.id)?.method ?? 'unknown', message.error));
      else this.#settle(message.id, 'resolve', message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const keys = [`${message.sessionId ?? ''}\n${message.method}`, `\n${message.method}`];
    for (const key of new Set(keys)) {
      for (const handler of [...(this.#subscribers.get(key) ?? [])]) {
        try { handler(message.params ?? {}, message.sessionId); } catch (error) {
          this.#diagnostic({ code: 'tiktok_browser.cdp_event_handler_failed', method: message.method, error: errorMessage(error).replace(/(?:https?|wss?):\/\/\S+/giu, '[redacted-url]').slice(0, 240) });
        }
      }
    }
  }

  #settle(id, action, value) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    pending[action](value);
  }

  #disconnect(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolveDisconnected(error);
    for (const [type, handler] of Object.entries(this.#listeners)) this.#socket.removeEventListener(type, handler);
    for (const id of [...this.#pending.keys()]) this.#settle(id, 'reject', error);
    this.#subscribers.clear();
  }

  #diagnostic(value) {
    try { this.#onDiagnostic(value); } catch { /* diagnostics are non-fatal */ }
  }
}

export function waitForWebSocketOpen(socket, signal) {
  if (socket.readyState === 1) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (event) => { cleanup(); reject(event.error ?? new Error('CDP WebSocket failed')); };
    const onClose = () => { cleanup(); reject(new Error('CDP WebSocket closed before opening')); };
    const onAbort = () => { cleanup(); try { socket.close(); } catch {} reject(abortError()); };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
