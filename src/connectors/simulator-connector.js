const FIXED_TIME = "2026-01-01T12:00:00.000Z";

export const SIMULATOR_SCENARIOS = Object.freeze({
  "quiet-chat": [
    { id: "quiet-1", kind: "comment", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u1", name: "Tom" }, text: "What sword are you using?" },
    { id: "quiet-2", kind: "follow", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u2", name: "Mary" } },
  ],
  "mixed-burst": [
    { id: "mixed-1", kind: "comment", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u1", name: "John" }, text: "hi" },
    { id: "mixed-2", kind: "comment", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u2", name: "Mary" }, text: "What weapon are you using?" },
    { id: "mixed-3", kind: "comment", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u3", name: "Alex" }, text: "  what weapon are you using?  " },
    { id: "mixed-4", kind: "gift", timestamp: FIXED_TIME, platform: "tiktok", user: { id: "u4", name: "Sam" }, gift: { id: "rose", name: "Rose", count: 3, streakEnded: true } },
    { id: "mixed-5", kind: "viewer_count", timestamp: FIXED_TIME, platform: "tiktok", count: 128 },
    { id: "mixed-6", kind: "future_native_event", timestamp: FIXED_TIME, platform: "tiktok", experimental: true },
  ],
  "malformed-input": [
    null,
    "not-an-object",
    { id: "malformed-1", platform: "tiktok", unexpected: "shape" },
    { id: "malformed-2", kind: "comment", timestamp: "not-a-date", platform: "tiktok", text: 42 },
  ],
});

export class SimulatorConnector {
  name = "simulator";

  constructor({ scenario = "quiet-chat", scenarios = SIMULATOR_SCENARIOS } = {}) {
    if (!Object.hasOwn(scenarios, scenario)) {
      throw new RangeError(`Unknown simulator scenario: ${scenario}`);
    }
    this.scenario = scenario;
    this.scenarios = scenarios;
  }

  async *events(signal) {
    for (const payload of this.scenarios[this.scenario]) {
      if (signal?.aborted) return;
      yield payload;
    }
  }
}

