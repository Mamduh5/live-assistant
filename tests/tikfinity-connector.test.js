import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, TikFinityConnector } from "../src/index.js";

class MockWebSocket {
  listeners = new Map();
  closeCalls = 0;

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
  }

  emit(type, fields = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(fields);
  }

  open() {
    this.emit("open");
  }

  message(value) {
    this.emit("message", { data: value });
  }

  fail(error = new Error("connection refused")) {
    this.emit("error", { error });
  }

  serverClose({ code = 1006, reason = "server stopped", wasClean = false } = {}) {
    this.emit("close", { code, reason, wasClean });
  }

  close() {
    this.closeCalls += 1;
    this.emit("close", { code: 1000, reason: "client shutdown", wasClean: true });
  }
}

class SocketHarness {
  sockets = [];
  urls = [];

  factory = (url) => {
    const socket = new MockWebSocket();
    this.urls.push(url);
    this.sockets.push(socket);
    return socket;
  };
}

class TimerHarness {
  waits = [];

  sleep = (delayMs, signal) => new Promise((resolve) => {
    const wait = { delayMs, resolve };
    this.waits.push(wait);
    signal.addEventListener("abort", resolve, { once: true });
  });

  release(index) {
    this.waits[index].resolve();
  }
}

async function until(predicate, message = "condition") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function createConnector({ harness = new SocketHarness(), timers = new TimerHarness(), diagnostics = [], states = [], reconnect = {}, factory } = {}) {
  const connector = new TikFinityConnector({
    url: DEFAULT_CONFIG.tikfinity.url,
    reconnect: {
      initialDelayMs: 100,
      maxDelayMs: 250,
      multiplier: 2,
      jitterRatio: 0,
      ...reconnect,
    },
    webSocketFactory: factory ?? harness.factory,
    sleep: timers.sleep,
    random: () => 0.5,
    onDiagnostic: (value) => diagnostics.push(value),
  });
  connector.subscribeState((state) => states.push(state));
  return { connector, harness, timers, diagnostics, states };
}

async function stop(connector, iterator) {
  await connector.close();
  return iterator.next();
}

test("connects with the configured native-style client and receives a valid envelope", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => context.harness.sockets.length === 1, "first socket");
  context.harness.sockets[0].open();
  context.harness.sockets[0].message(JSON.stringify({ event: "chat", data: { comment: "hello" } }));
  assert.deepEqual((await next).value, { event: "chat", data: { comment: "hello" } });
  assert.deepEqual(context.harness.urls, ["ws://127.0.0.1:21213/"]);
  assert.deepEqual(context.states.slice(0, 3), ["idle", "connecting", "connected"]);
  assert.equal(context.diagnostics.some(({ code }) => code === "tikfinity.connected"), true);
  assert.equal((await stop(context.connector, iterator)).done, true);
});

test("preserves message order", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const first = iterator.next();
  await until(() => context.harness.sockets.length === 1);
  const socket = context.harness.sockets[0];
  socket.open();
  socket.message(JSON.stringify({ event: "follow", data: { sequence: 1 } }));
  socket.message(JSON.stringify({ event: "share", data: { sequence: 2 } }));
  assert.equal((await first).value.data.sequence, 1);
  assert.equal((await iterator.next()).value.data.sequence, 2);
  await stop(context.connector, iterator);
});

test("reports and skips malformed frames without logging raw data", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => context.harness.sockets.length === 1);
  const socket = context.harness.sockets[0];
  socket.open();
  socket.message("{invalid-json");
  socket.message(JSON.stringify({ data: {} }));
  socket.message(JSON.stringify({ event: "   ", data: {} }));
  socket.message(JSON.stringify({ event: "somethingNew", data: { privateText: "not logged" } }));
  assert.equal((await next).value.event, "somethingNew");
  assert.deepEqual(context.diagnostics.filter(({ code }) => code.startsWith("tikfinity.message_")).map(({ code }) => code), [
    "tikfinity.message_invalid_json",
    "tikfinity.message_invalid_envelope",
    "tikfinity.message_invalid_envelope",
  ]);
  assert.equal(JSON.stringify(context.diagnostics).includes("privateText"), false);
  await stop(context.connector, iterator);
});

test("unexpected disconnect automatically reconnects", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => context.harness.sockets.length === 1);
  context.harness.sockets[0].open();
  context.harness.sockets[0].serverClose();
  await until(() => context.timers.waits.length === 1, "reconnect timer");
  assert.equal(context.timers.waits[0].delayMs, 100);
  context.timers.release(0);
  await until(() => context.harness.sockets.length === 2, "replacement socket");
  context.harness.sockets[1].open();
  context.harness.sockets[1].message(JSON.stringify({ event: "follow", data: {} }));
  assert.equal((await next).value.event, "follow");
  assert.equal(context.states.includes("reconnecting"), true);
  await stop(context.connector, iterator);
});

test("connection failures grow backoff and cap it", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();

  for (let index = 0; index < 3; index += 1) {
    await until(() => context.harness.sockets.length === index + 1, `socket ${index + 1}`);
    context.harness.sockets[index].fail();
    await until(() => context.timers.waits.length === index + 1, `timer ${index + 1}`);
    if (index < 2) context.timers.release(index);
  }

  assert.deepEqual(context.timers.waits.map(({ delayMs }) => delayMs), [100, 200, 250]);
  assert.equal(context.diagnostics.filter(({ code }) => code === "tikfinity.connection_failed").length, 3);
  await context.connector.close();
  assert.equal((await next).done, true);
});

test("a successful connection resets reconnect backoff", async () => {
  const context = createConnector();
  const iterator = context.connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => context.harness.sockets.length === 1);
  context.harness.sockets[0].fail();
  await until(() => context.timers.waits.length === 1);
  context.timers.release(0);
  await until(() => context.harness.sockets.length === 2);
  context.harness.sockets[1].open();
  context.harness.sockets[1].serverClose();
  await until(() => context.timers.waits.length === 2);
  assert.deepEqual(context.timers.waits.map(({ delayMs }) => delayMs), [100, 100]);
  await context.connector.close();
  assert.equal((await next).done, true);
});

test("jitter is bounded by the configured maximum delay", async () => {
  const harness = new SocketHarness();
  const timers = new TimerHarness();
  const connector = new TikFinityConnector({
    url: DEFAULT_CONFIG.tikfinity.url,
    reconnect: { initialDelayMs: 250, maxDelayMs: 250, multiplier: 2, jitterRatio: 0.5 },
    webSocketFactory: harness.factory,
    sleep: timers.sleep,
    random: () => 1,
  });
  const iterator = connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => harness.sockets.length === 1);
  harness.sockets[0].fail();
  await until(() => timers.waits.length === 1);
  assert.equal(timers.waits[0].delayMs, 250);
  await connector.close();
  assert.equal((await next).done, true);
});

test("maximum negative jitter cannot create a zero-delay retry loop", async () => {
  const harness = new SocketHarness();
  const timers = new TimerHarness();
  const connector = new TikFinityConnector({
    url: DEFAULT_CONFIG.tikfinity.url,
    reconnect: { initialDelayMs: 100, maxDelayMs: 100, multiplier: 1, jitterRatio: 1 },
    webSocketFactory: harness.factory,
    sleep: timers.sleep,
    random: () => 0,
  });
  const iterator = connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => harness.sockets.length === 1);
  harness.sockets[0].fail();
  await until(() => timers.waits.length === 1);
  assert.equal(timers.waits[0].delayMs, 1);
  await connector.close();
  assert.equal((await next).done, true);
});

test("AbortSignal cancels an active connection and prevents reconnect", async () => {
  const context = createConnector();
  const abortController = new AbortController();
  const iterator = context.connector.events(abortController.signal)[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => context.harness.sockets.length === 1);
  abortController.abort();
  assert.equal((await next).done, true);
  assert.equal(context.harness.sockets[0].closeCalls, 1);
  assert.equal(context.timers.waits.length, 0);
  assert.equal(context.connector.state, "disconnected");
});

test("explicit close cancels reconnect and a later events call starts a new lifecycle", async () => {
  const context = createConnector();
  const firstIterator = context.connector.events()[Symbol.asyncIterator]();
  const firstNext = firstIterator.next();
  await until(() => context.harness.sockets.length === 1);
  context.harness.sockets[0].fail();
  await until(() => context.timers.waits.length === 1);
  await context.connector.close();
  assert.equal((await firstNext).done, true);
  assert.equal(context.harness.sockets.length, 1);

  const secondIterator = context.connector.events()[Symbol.asyncIterator]();
  const secondNext = secondIterator.next();
  await until(() => context.harness.sockets.length === 2);
  context.harness.sockets[1].open();
  context.harness.sockets[1].message(JSON.stringify({ event: "follow", data: {} }));
  assert.equal((await secondNext).value.event, "follow");
  await stop(context.connector, secondIterator);
});

test("connection refusal is an observable non-fatal reconnect state", async () => {
  const timers = new TimerHarness();
  const diagnostics = [];
  const states = [];
  const { connector } = createConnector({
    timers,
    diagnostics,
    states,
    factory() { throw new Error("ECONNREFUSED"); },
  });
  const iterator = connector.events()[Symbol.asyncIterator]();
  const next = iterator.next();
  await until(() => timers.waits.length === 1);
  assert.equal(states.includes("error"), true);
  assert.equal(states.at(-1), "reconnecting");
  assert.equal(diagnostics.some(({ code }) => code === "tikfinity.connection_failed"), true);
  await connector.close();
  assert.equal((await next).done, true);
});
