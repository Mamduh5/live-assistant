import { randomUUID } from "node:crypto";
import { LiveEventType, createLiveEvent, createUnknownEvent } from "../events/live-event.js";

const FIXED_TIME = Date.parse("2026-01-01T12:00:00.000Z");

export const SIMULATOR_SCENARIOS = Object.freeze({
  "quiet-chat": [
    { type: LiveEventType.CHAT_MESSAGE, user: { id: "u1", displayName: "Tom" }, data: { text: "What sword are you using?" } },
    { type: LiveEventType.SOCIAL_FOLLOW, user: { id: "u2", displayName: "Mary" }, data: {} },
  ],
  "mixed-burst": [
    { type: LiveEventType.CHAT_MESSAGE, user: { id: "u1", displayName: "John" }, data: { text: "hi" } },
    { type: LiveEventType.CHAT_MESSAGE, user: { id: "u2", displayName: "Mary" }, data: { text: "What weapon are you using?" } },
    { type: LiveEventType.CHAT_MESSAGE, user: { id: "u3", displayName: "Alex" }, data: { text: "  what weapon are you using?  " } },
    { type: LiveEventType.GIFT_RECEIVED, user: { id: "u4", displayName: "Sam" }, data: { giftId: "rose", giftName: "Rose", quantity: 3, streak: { active: false, completed: true, repeatCount: 3 } } },
    { type: LiveEventType.ROOM_VIEWER_COUNT, data: { count: 128 } },
    { type: LiveEventType.PLATFORM_UNKNOWN, data: { reason: "simulated_unknown", nativeEventType: "future_native_event" }, raw: { experimental: true } },
  ],
  "malformed-input": [
    { type: LiveEventType.PLATFORM_UNKNOWN, data: { reason: "malformed_payload" }, raw: null },
    { type: LiveEventType.PLATFORM_UNKNOWN, data: { reason: "malformed_payload" }, raw: "not-an-object" },
    { type: LiveEventType.PLATFORM_UNKNOWN, data: { reason: "unsupported_event_type" }, raw: { unexpected: "shape" } },
    { type: LiveEventType.PLATFORM_UNKNOWN, data: { reason: "malformed_event_data", nativeEventType: "comment" }, raw: { kind: "comment", text: 42 } },
  ],
});

export const RAW_SIMULATOR_SCENARIOS = Object.freeze({
  "raw-normalization": [
    { kind: "comment", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u1", name: "Ada" }, text: "hello" },
    { kind: "gift", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u2", name: "Lin" }, gift: { id: "rose", name: "Rose", quantity: 2 } },
    { kind: "future_native_event", timestamp: FIXED_TIME, platform: "tiktok", experimental: true },
  ],
  "raw-malformed": [null, "not-an-object", { kind: "comment", text: 42 }],
});

class SimulatorLifecycle {
  #state = "idle";
  #closed = false;
  #subscribers = [];

  get state() {
    return this.#state;
  }

  subscribeState(handler) {
    if (typeof handler !== "function") throw new TypeError("State subscriber must be a function");
    this.#subscribers.push(handler);
    handler(this.#state);
    return () => {
      const index = this.#subscribers.indexOf(handler);
      if (index >= 0) this.#subscribers.splice(index, 1);
    };
  }

  async close() {
    this.#closed = true;
    this.transition("disconnected");
  }

  begin() {
    this.#closed = false;
    this.transition("connected");
  }

  shouldStop(signal) {
    return this.#closed || signal?.aborted === true;
  }

  transition(state) {
    if (state === this.#state) return;
    this.#state = state;
    for (const subscriber of [...this.#subscribers]) subscriber(state);
  }
}

export class SimulatorConnector extends SimulatorLifecycle {
  name = "simulator";

  constructor({ scenario = "quiet-chat", scenarios = SIMULATOR_SCENARIOS, clock = Date.now, idFactory = randomUUID } = {}) {
    super();
    if (!Object.hasOwn(scenarios, scenario)) throw new RangeError(`Unknown simulator scenario: ${scenario}`);
    this.scenario = scenario;
    this.scenarios = scenarios;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async *events(signal) {
    this.begin();
    try {
      for (const [index, template] of this.scenarios[this.scenario].entries()) {
        if (this.shouldStop(signal)) return;
        const receivedAt = this.clock();
        const common = {
          id: this.idFactory(),
          platform: "tiktok",
          connector: this.name,
          timestamp: FIXED_TIME,
          receivedAt,
          raw: Object.hasOwn(template, "raw")
            ? template.raw
            : { simulatorScenario: this.scenario, simulatorIndex: index },
        };
        yield template.type === LiveEventType.PLATFORM_UNKNOWN
          ? createUnknownEvent({ ...common, ...template.data })
          : createLiveEvent({ ...common, type: template.type, ...(template.user ? { user: template.user } : {}), data: template.data });
      }
    } finally {
      this.transition("disconnected");
    }
  }
}

export class RawSimulatorConnector extends SimulatorLifecycle {
  name = "raw-simulator";

  constructor({ scenario = "raw-normalization", scenarios = RAW_SIMULATOR_SCENARIOS } = {}) {
    super();
    if (!Object.hasOwn(scenarios, scenario)) throw new RangeError(`Unknown raw simulator scenario: ${scenario}`);
    this.scenario = scenario;
    this.scenarios = scenarios;
  }

  async *events(signal) {
    this.begin();
    try {
      for (const payload of this.scenarios[this.scenario]) {
        if (this.shouldStop(signal)) return;
        yield payload;
      }
    } finally {
      this.transition("disconnected");
    }
  }
}
