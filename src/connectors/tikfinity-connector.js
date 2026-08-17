const ABORTED = Symbol("aborted");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "WebSocket error");
}

function safeClose(socket) {
  try {
    socket?.close(1000, "Live Assistant shutdown");
  } catch {
    // A native WebSocket can reject close() while its constructor is still connecting.
  }
}

function waitWithAbort(promise, signal) {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function abortableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

class AsyncMessageChannel {
  #messages = [];
  #waiters = [];
  #closed = false;
  #closeDetail;

  push(message) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ kind: "message", value: message });
    else this.#messages.push(message);
  }

  close(detail) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeDetail = detail;
    for (const waiter of this.#waiters.splice(0)) waiter({ kind: "closed", detail });
  }

  next() {
    if (this.#messages.length > 0) return Promise.resolve({ kind: "message", value: this.#messages.shift() });
    if (this.#closed) return Promise.resolve({ kind: "closed", detail: this.#closeDetail });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function validateConfig({ url, reconnect }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("TikFinity URL must be a valid WebSocket URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new TypeError("TikFinity URL must use ws: or wss:");
  if (!reconnect || typeof reconnect !== "object") throw new TypeError("TikFinity reconnect configuration is required");
  if (!Number.isSafeInteger(reconnect.initialDelayMs) || reconnect.initialDelayMs < 1) throw new RangeError("TikFinity initial reconnect delay must be a positive integer");
  if (!Number.isSafeInteger(reconnect.maxDelayMs) || reconnect.maxDelayMs < reconnect.initialDelayMs) throw new RangeError("TikFinity maximum reconnect delay must be at least the initial delay");
  if (!Number.isFinite(reconnect.multiplier) || reconnect.multiplier < 1) throw new RangeError("TikFinity reconnect multiplier must be at least 1");
  if (!Number.isFinite(reconnect.jitterRatio) || reconnect.jitterRatio < 0 || reconnect.jitterRatio > 1) throw new RangeError("TikFinity reconnect jitter ratio must be between 0 and 1");
}

export class TikFinityConnector {
  name = "tikfinity";
  #state = "idle";
  #stateSubscribers = [];
  #active = false;
  #stopController;
  #socket;
  #url;
  #reconnect;
  #webSocketFactory;
  #sleep;
  #random;
  #onDiagnostic;

  constructor({ url, reconnect, webSocketFactory, sleep = abortableDelay, random = Math.random, onDiagnostic = () => {} }) {
    validateConfig({ url, reconnect });
    this.#url = url;
    this.#reconnect = { ...reconnect };
    this.#webSocketFactory = webSocketFactory ?? ((endpoint) => new WebSocket(endpoint));
    this.#sleep = sleep;
    this.#random = random;
    this.#onDiagnostic = onDiagnostic;
  }

  get state() {
    return this.#state;
  }

  subscribeState(handler) {
    if (typeof handler !== "function") throw new TypeError("State subscriber must be a function");
    this.#stateSubscribers.push(handler);
    handler(this.#state);
    return () => {
      const index = this.#stateSubscribers.indexOf(handler);
      if (index >= 0) this.#stateSubscribers.splice(index, 1);
    };
  }

  async close() {
    this.#requestStop();
    this.#transition("disconnected");
  }

  async *events(signal) {
    if (this.#active) throw new Error("TikFinityConnector already has an active event stream");
    this.#active = true;
    this.#stopController = new AbortController();
    const lifecycleSignal = this.#stopController.signal;
    const onExternalAbort = () => this.#requestStop();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    let reconnectBaseMs = this.#reconnect.initialDelayMs;
    let attempt = 0;

    try {
      if (signal?.aborted) return;
      while (!lifecycleSignal.aborted) {
        attempt += 1;
        this.#transition(attempt === 1 ? "connecting" : "reconnecting");
        this.#diagnostic({ code: "tikfinity.connecting", url: this.#url, attempt });

        let session;
        try {
          session = this.#openSession();
          this.#socket = session.socket;
        } catch (error) {
          this.#transition("error");
          this.#diagnostic({ code: "tikfinity.connection_failed", url: this.#url, attempt, error: errorMessage(error) });
          const waited = await this.#scheduleReconnect(reconnectBaseMs, lifecycleSignal, attempt);
          if (waited === ABORTED) break;
          reconnectBaseMs = this.#nextReconnectBase(reconnectBaseMs);
          continue;
        }

        const opened = await waitWithAbort(session.opened, lifecycleSignal);
        if (opened === ABORTED) {
          session.cleanup();
          break;
        }
        if (!opened.connected) {
          session.cleanup();
          this.#socket = undefined;
          this.#transition("error");
          this.#diagnostic({
            code: "tikfinity.connection_failed",
            url: this.#url,
            attempt,
            error: opened.error ?? "Connection closed before opening",
          });
          const waited = await this.#scheduleReconnect(reconnectBaseMs, lifecycleSignal, attempt);
          if (waited === ABORTED) break;
          reconnectBaseMs = this.#nextReconnectBase(reconnectBaseMs);
          continue;
        }

        this.#transition("connected");
        this.#diagnostic({ code: "tikfinity.connected", url: this.#url });
        reconnectBaseMs = this.#reconnect.initialDelayMs;

        let closeDetail;
        while (!lifecycleSignal.aborted) {
          const item = await waitWithAbort(session.messages.next(), lifecycleSignal);
          if (item === ABORTED) break;
          if (item.kind === "closed") {
            closeDetail = item.detail;
            break;
          }
          yield item.value;
        }

        session.cleanup();
        this.#socket = undefined;
        if (lifecycleSignal.aborted) break;
        this.#transition("disconnected");
        this.#diagnostic({
          code: "tikfinity.disconnected",
          url: this.#url,
          codeValue: closeDetail?.code,
          reason: closeDetail?.reason,
          wasClean: closeDetail?.wasClean,
        });
        const waited = await this.#scheduleReconnect(reconnectBaseMs, lifecycleSignal, attempt);
        if (waited === ABORTED) break;
        reconnectBaseMs = this.#nextReconnectBase(reconnectBaseMs);
      }
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
      safeClose(this.#socket);
      this.#socket = undefined;
      this.#active = false;
      this.#transition("disconnected");
    }
  }

  #openSession() {
    const socket = this.#webSocketFactory(this.#url);
    if (!socket || typeof socket.addEventListener !== "function") throw new TypeError("WebSocket factory returned an invalid client");

    const opened = deferred();
    const messages = new AsyncMessageChannel();
    let didOpen = false;
    let openSettled = false;

    const settleOpen = (result) => {
      if (openSettled) return;
      openSettled = true;
      opened.resolve(result);
    };
    const onOpen = () => {
      didOpen = true;
      settleOpen({ connected: true });
    };
    const onMessage = (messageEvent) => this.#handleMessage(messageEvent.data, messages);
    const onError = (errorEvent) => {
      const error = errorMessage(errorEvent.error);
      if (!didOpen) settleOpen({ connected: false, error });
      else this.#diagnostic({ code: "tikfinity.connection_failed", url: this.#url, error });
      messages.close({ reason: "WebSocket error", error });
      safeClose(socket);
    };
    const onClose = (closeEvent) => {
      settleOpen({ connected: false, error: closeEvent.reason || "Socket closed" });
      messages.close({
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    return {
      socket,
      opened: opened.promise,
      messages,
      cleanup() {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      },
    };
  }

  #handleMessage(frame, messages) {
    if (typeof frame !== "string") {
      this.#diagnostic({ code: "tikfinity.message_invalid_json", reason: "non_text_frame" });
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(frame);
    } catch (error) {
      this.#diagnostic({ code: "tikfinity.message_invalid_json", error: errorMessage(error) });
      return;
    }

    if (!isRecord(envelope) || typeof envelope.event !== "string" || envelope.event.trim().length === 0) {
      this.#diagnostic({ code: "tikfinity.message_invalid_envelope" });
      return;
    }
    messages.push(envelope);
  }

  async #scheduleReconnect(baseDelayMs, signal, attempt) {
    const spread = (this.#random() * 2) - 1;
    const jittered = baseDelayMs * (1 + (spread * this.#reconnect.jitterRatio));
    const delayMs = Math.round(Math.min(this.#reconnect.maxDelayMs, Math.max(1, jittered)));
    this.#transition("reconnecting");
    this.#diagnostic({ code: "tikfinity.reconnect_scheduled", attempt, delayMs });
    return waitWithAbort(Promise.resolve(this.#sleep(delayMs, signal)), signal);
  }

  #nextReconnectBase(currentDelayMs) {
    return Math.min(this.#reconnect.maxDelayMs, currentDelayMs * this.#reconnect.multiplier);
  }

  #requestStop() {
    this.#stopController?.abort();
    const socket = this.#socket;
    this.#socket = undefined;
    safeClose(socket);
  }

  #transition(state) {
    if (state === this.#state) return;
    this.#state = state;
    for (const subscriber of [...this.#stateSubscribers]) {
      try {
        subscriber(state);
      } catch (error) {
        this.#diagnostic({ code: "tikfinity.state_subscriber_failed", error: errorMessage(error) });
      }
    }
  }

  #diagnostic(diagnostic) {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Observability callbacks must not terminate connector transport.
    }
  }
}
