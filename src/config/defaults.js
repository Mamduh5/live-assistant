export const DEFAULT_CONFIG = Object.freeze({
  eventBus: Object.freeze({ maxQueue: 256 }),
  eventHistory: Object.freeze({ limit: 500 }),
  speechPolicy: Object.freeze({
    enabledEventTypes: Object.freeze(["chat.message"]),
    duplicateWindowMs: 5_000,
    perUserCooldownMs: 2_000,
    maxMessageLength: 240,
    maxTrackedMessages: 500,
    maxTrackedUsers: 500,
    queuePressureThreshold: 0.9,
    allowUrls: false,
    disabledUserIds: Object.freeze([]),
  }),
  speechQueue: Object.freeze({ maxQueue: 64 }),
  inspector: Object.freeze({ includeRaw: false }),
});

const POSITIVE_INTEGER_FIELDS = [
  ["LIVE_ASSISTANT_EVENT_QUEUE_LIMIT", "eventBus", "maxQueue"],
  ["LIVE_ASSISTANT_HISTORY_LIMIT", "eventHistory", "limit"],
  ["LIVE_ASSISTANT_SPEECH_QUEUE_LIMIT", "speechQueue", "maxQueue"],
  ["LIVE_ASSISTANT_DUPLICATE_WINDOW_MS", "speechPolicy", "duplicateWindowMs"],
  ["LIVE_ASSISTANT_USER_COOLDOWN_MS", "speechPolicy", "perUserCooldownMs"],
  ["LIVE_ASSISTANT_MAX_MESSAGE_LENGTH", "speechPolicy", "maxMessageLength"],
];

const BOOLEAN_FIELDS = [
  ["LIVE_ASSISTANT_INSPECT_RAW", "inspector", "includeRaw"],
  ["LIVE_ASSISTANT_ALLOW_URLS", "speechPolicy", "allowUrls"],
];

function positiveInteger(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalid(onDiagnostic, environmentName, value, fallback) {
  onDiagnostic({ code: "config.invalid", field: environmentName, value, fallback });
}

export function loadConfig(environment = process.env, onDiagnostic = () => {}) {
  const config = {
    eventBus: { ...DEFAULT_CONFIG.eventBus },
    eventHistory: { ...DEFAULT_CONFIG.eventHistory },
    speechPolicy: {
      ...DEFAULT_CONFIG.speechPolicy,
      enabledEventTypes: [...DEFAULT_CONFIG.speechPolicy.enabledEventTypes],
      disabledUserIds: [...DEFAULT_CONFIG.speechPolicy.disabledUserIds],
    },
    speechQueue: { ...DEFAULT_CONFIG.speechQueue },
    inspector: { ...DEFAULT_CONFIG.inspector },
  };

  for (const [environmentName, section, field] of POSITIVE_INTEGER_FIELDS) {
    const parsed = positiveInteger(environment[environmentName]);
    if (parsed === undefined) continue;
    if (parsed === null) invalid(onDiagnostic, environmentName, environment[environmentName], config[section][field]);
    else config[section][field] = parsed;
  }

  for (const [environmentName, section, field] of BOOLEAN_FIELDS) {
    const value = environment[environmentName];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false") invalid(onDiagnostic, environmentName, value, config[section][field]);
    else config[section][field] = value === "true";
  }

  return config;
}
