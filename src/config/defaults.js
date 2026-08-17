export const DEFAULT_CONFIG = Object.freeze({
  tikfinity: Object.freeze({
    url: "ws://127.0.0.1:21213/",
    reconnect: Object.freeze({
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      multiplier: 2,
      jitterRatio: 0.2,
    }),
  }),
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
  speechEngine: Object.freeze({
    type: "off",
    windows: Object.freeze({
      executable: "powershell.exe",
      voice: null,
      rate: 0,
      volume: 100,
    }),
  }),
  controlServer: Object.freeze({
    host: "127.0.0.1",
    port: 4820,
    maxBodyBytes: 4096,
    maxSseClients: 32,
  }),
  inspector: Object.freeze({ includeRaw: false }),
});

const POSITIVE_INTEGER_FIELDS = [
  ["LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS", "tikfinity.reconnect", "initialDelayMs"],
  ["LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS", "tikfinity.reconnect", "maxDelayMs"],
  ["LIVE_ASSISTANT_EVENT_QUEUE_LIMIT", "eventBus", "maxQueue"],
  ["LIVE_ASSISTANT_HISTORY_LIMIT", "eventHistory", "limit"],
  ["LIVE_ASSISTANT_SPEECH_QUEUE_LIMIT", "speechQueue", "maxQueue"],
  ["LIVE_ASSISTANT_DUPLICATE_WINDOW_MS", "speechPolicy", "duplicateWindowMs"],
  ["LIVE_ASSISTANT_USER_COOLDOWN_MS", "speechPolicy", "perUserCooldownMs"],
  ["LIVE_ASSISTANT_MAX_MESSAGE_LENGTH", "speechPolicy", "maxMessageLength"],
  ["LIVE_ASSISTANT_CONTROL_PORT", "controlServer", "port"],
];

const BOOLEAN_FIELDS = [
  ["LIVE_ASSISTANT_INSPECT_RAW", "inspector", "includeRaw"],
  ["LIVE_ASSISTANT_ALLOW_URLS", "speechPolicy", "allowUrls"],
];

const NUMBER_FIELDS = [
  ["LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER", "tikfinity.reconnect", "multiplier", (value) => value >= 1],
  ["LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO", "tikfinity.reconnect", "jitterRatio", (value) => value >= 0 && value <= 1],
];

const INTEGER_RANGE_FIELDS = [
  ["LIVE_ASSISTANT_SPEECH_RATE", "speechEngine.windows", "rate", -10, 10],
  ["LIVE_ASSISTANT_SPEECH_VOLUME", "speechEngine.windows", "volume", 0, 100],
];

function positiveInteger(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalid(onDiagnostic, environmentName, value, fallback) {
  onDiagnostic({ code: "config.invalid", field: environmentName, value, fallback });
}

function sectionAt(config, path) {
  return path.split(".").reduce((section, key) => section[key], config);
}

function validWebSocketUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

export function loadConfig(environment = process.env, onDiagnostic = () => {}) {
  const config = {
    tikfinity: {
      ...DEFAULT_CONFIG.tikfinity,
      reconnect: { ...DEFAULT_CONFIG.tikfinity.reconnect },
    },
    eventBus: { ...DEFAULT_CONFIG.eventBus },
    eventHistory: { ...DEFAULT_CONFIG.eventHistory },
    speechPolicy: {
      ...DEFAULT_CONFIG.speechPolicy,
      enabledEventTypes: [...DEFAULT_CONFIG.speechPolicy.enabledEventTypes],
      disabledUserIds: [...DEFAULT_CONFIG.speechPolicy.disabledUserIds],
    },
    speechQueue: { ...DEFAULT_CONFIG.speechQueue },
    speechEngine: {
      ...DEFAULT_CONFIG.speechEngine,
      windows: { ...DEFAULT_CONFIG.speechEngine.windows },
    },
    controlServer: { ...DEFAULT_CONFIG.controlServer },
    inspector: { ...DEFAULT_CONFIG.inspector },
  };

  for (const [environmentName, section, field] of POSITIVE_INTEGER_FIELDS) {
    const parsed = positiveInteger(environment[environmentName]);
    if (parsed === undefined) continue;
    const target = sectionAt(config, section);
    if (parsed === null) invalid(onDiagnostic, environmentName, environment[environmentName], target[field]);
    else target[field] = parsed;
  }

  for (const [environmentName, section, field] of BOOLEAN_FIELDS) {
    const value = environment[environmentName];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false") invalid(onDiagnostic, environmentName, value, config[section][field]);
    else config[section][field] = value === "true";
  }


  for (const [environmentName, section, field, predicate] of NUMBER_FIELDS) {
    const raw = environment[environmentName];
    if (raw === undefined) continue;
    const value = Number(raw);
    const target = sectionAt(config, section);
    if (!Number.isFinite(value) || !predicate(value)) invalid(onDiagnostic, environmentName, raw, target[field]);
    else target[field] = value;
  }

  for (const [environmentName, section, field, minimum, maximum] of INTEGER_RANGE_FIELDS) {
    const raw = environment[environmentName];
    if (raw === undefined) continue;
    const value = Number(raw);
    const target = sectionAt(config, section);
    if (raw.length === 0 || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      invalid(onDiagnostic, environmentName, raw, target[field]);
    } else {
      target[field] = value;
    }
  }

  const speechEngine = environment.LIVE_ASSISTANT_SPEECH_ENGINE;
  if (speechEngine !== undefined) {
    if (speechEngine === "off" || speechEngine === "windows") config.speechEngine.type = speechEngine;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_SPEECH_ENGINE", speechEngine, config.speechEngine.type);
  }

  const speechVoice = environment.LIVE_ASSISTANT_SPEECH_VOICE;
  if (speechVoice !== undefined) {
    if (speechVoice.trim().length > 0) config.speechEngine.windows.voice = speechVoice;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_SPEECH_VOICE", speechVoice, config.speechEngine.windows.voice);
  }

  const url = environment.LIVE_ASSISTANT_TIKFINITY_URL;
  if (url !== undefined) {
    if (validWebSocketUrl(url)) config.tikfinity.url = url;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_TIKFINITY_URL", url, config.tikfinity.url);
  }

  const controlHost = environment.LIVE_ASSISTANT_CONTROL_HOST;
  if (controlHost !== undefined) {
    if (["127.0.0.1", "localhost", "::1"].includes(controlHost)) config.controlServer.host = controlHost;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_CONTROL_HOST", controlHost, config.controlServer.host);
  }

  if (config.controlServer.port > 65_535) {
    invalid(onDiagnostic, "LIVE_ASSISTANT_CONTROL_PORT", config.controlServer.port, DEFAULT_CONFIG.controlServer.port);
    config.controlServer.port = DEFAULT_CONFIG.controlServer.port;
  }

  if (config.tikfinity.reconnect.maxDelayMs < config.tikfinity.reconnect.initialDelayMs) {
    invalid(onDiagnostic, "tikfinity.reconnect", config.tikfinity.reconnect, DEFAULT_CONFIG.tikfinity.reconnect);
    config.tikfinity.reconnect = { ...DEFAULT_CONFIG.tikfinity.reconnect };
  }

  return config;
}
