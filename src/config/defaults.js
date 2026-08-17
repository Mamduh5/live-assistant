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
  attention: Object.freeze({
    mode: "passthrough",
    recentWindowMs: 10_000,
    maxRecentMessages: 500,
    groupWindowMs: 1_500,
    maxPendingGroups: 128,
    decisionHistoryLimit: 200,
    ai: Object.freeze({
      provider: "openai",
      batchWindowMs: 1_000,
      maxBatchMessages: 20,
      maxBatchItems: 20,
      maxBatchChars: 6_000,
      maxPendingBatches: 3,
      maxConcurrentRequests: 1,
      maxSummaryChars: 160,
      requestsPerMinute: 30,
      failureThreshold: 3,
      circuitCooldownMs: 30_000,
      openai: Object.freeze({
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        verbosity: "low",
        requestTimeoutMs: 6_000,
        baseUrl: "https://api.openai.com/v1/",
        maxResponseBytes: 131_072,
      }),
    }),
    scoring: Object.freeze({
      messageBase: 45,
      questionBase: 65,
      lowInformationBase: 10,
      repeatedQuestionBonusPerUser: 10,
      repeatedQuestionBonusCap: 25,
      quietThreshold: 40,
      busyMessageCount: 8,
      busyThreshold: 60,
      veryBusyMessageCount: 20,
      veryBusyThreshold: 75,
    }),
  }),
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
  ["LIVE_ASSISTANT_ATTENTION_RECENT_WINDOW_MS", "attention", "recentWindowMs"],
  ["LIVE_ASSISTANT_ATTENTION_GROUP_WINDOW_MS", "attention", "groupWindowMs"],
  ["LIVE_ASSISTANT_ATTENTION_MAX_RECENT_MESSAGES", "attention", "maxRecentMessages"],
  ["LIVE_ASSISTANT_ATTENTION_MAX_PENDING_GROUPS", "attention", "maxPendingGroups"],
  ["LIVE_ASSISTANT_ATTENTION_DECISION_HISTORY_LIMIT", "attention", "decisionHistoryLimit"],
  ["LIVE_ASSISTANT_ATTENTION_BUSY_MESSAGE_COUNT", "attention.scoring", "busyMessageCount"],
  ["LIVE_ASSISTANT_ATTENTION_VERY_BUSY_MESSAGE_COUNT", "attention.scoring", "veryBusyMessageCount"],
  ["LIVE_ASSISTANT_AI_BATCH_WINDOW_MS", "attention.ai", "batchWindowMs"],
  ["LIVE_ASSISTANT_AI_MAX_BATCH_MESSAGES", "attention.ai", "maxBatchMessages"],
  ["LIVE_ASSISTANT_AI_MAX_BATCH_CHARS", "attention.ai", "maxBatchChars"],
  ["LIVE_ASSISTANT_AI_REQUESTS_PER_MINUTE", "attention.ai", "requestsPerMinute"],
  ["LIVE_ASSISTANT_AI_REQUEST_TIMEOUT_MS", "attention.ai.openai", "requestTimeoutMs"],
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
  ["LIVE_ASSISTANT_ATTENTION_QUIET_THRESHOLD", "attention.scoring", "quietThreshold", 0, 100],
  ["LIVE_ASSISTANT_ATTENTION_BUSY_THRESHOLD", "attention.scoring", "busyThreshold", 0, 100],
  ["LIVE_ASSISTANT_ATTENTION_VERY_BUSY_THRESHOLD", "attention.scoring", "veryBusyThreshold", 0, 100],
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
    attention: {
      ...DEFAULT_CONFIG.attention,
      scoring: { ...DEFAULT_CONFIG.attention.scoring },
      ai: {
        ...DEFAULT_CONFIG.attention.ai,
        openai: { ...DEFAULT_CONFIG.attention.ai.openai },
      },
    },
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

  const attentionMode = environment.LIVE_ASSISTANT_ATTENTION_MODE;
  if (attentionMode !== undefined) {
    if (["passthrough", "deterministic", "ai"].includes(attentionMode)) config.attention.mode = attentionMode;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_ATTENTION_MODE", attentionMode, config.attention.mode);
  }

  const aiProvider = environment.LIVE_ASSISTANT_AI_PROVIDER;
  if (aiProvider !== undefined) {
    if (aiProvider === "openai") config.attention.ai.provider = aiProvider;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_AI_PROVIDER", aiProvider, config.attention.ai.provider);
  }

  const openAiModel = environment.LIVE_ASSISTANT_OPENAI_MODEL;
  if (openAiModel !== undefined) {
    if (openAiModel.trim().length > 0 && openAiModel.length <= 200) config.attention.ai.openai.model = openAiModel;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_OPENAI_MODEL", openAiModel, config.attention.ai.openai.model);
  }

  const reasoningEffort = environment.LIVE_ASSISTANT_OPENAI_REASONING_EFFORT;
  if (reasoningEffort !== undefined) {
    if (["none", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) config.attention.ai.openai.reasoningEffort = reasoningEffort;
    else invalid(onDiagnostic, "LIVE_ASSISTANT_OPENAI_REASONING_EFFORT", reasoningEffort, config.attention.ai.openai.reasoningEffort);
  }

  const openAiBaseUrl = environment.LIVE_ASSISTANT_OPENAI_BASE_URL;
  if (openAiBaseUrl !== undefined) {
    try {
      const parsed = new URL(openAiBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid");
      config.attention.ai.openai.baseUrl = parsed.href;
    } catch {
      invalid(onDiagnostic, "LIVE_ASSISTANT_OPENAI_BASE_URL", openAiBaseUrl, config.attention.ai.openai.baseUrl);
    }
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

  if (config.attention.scoring.veryBusyMessageCount <= config.attention.scoring.busyMessageCount) {
    invalid(onDiagnostic, "attention.scoring.messageCounts", {
      busyMessageCount: config.attention.scoring.busyMessageCount,
      veryBusyMessageCount: config.attention.scoring.veryBusyMessageCount,
    }, {
      busyMessageCount: DEFAULT_CONFIG.attention.scoring.busyMessageCount,
      veryBusyMessageCount: DEFAULT_CONFIG.attention.scoring.veryBusyMessageCount,
    });
    config.attention.scoring.busyMessageCount = DEFAULT_CONFIG.attention.scoring.busyMessageCount;
    config.attention.scoring.veryBusyMessageCount = DEFAULT_CONFIG.attention.scoring.veryBusyMessageCount;
  }

  if (!(
    config.attention.scoring.quietThreshold <= config.attention.scoring.busyThreshold &&
    config.attention.scoring.busyThreshold <= config.attention.scoring.veryBusyThreshold
  )) {
    invalid(onDiagnostic, "attention.scoring.thresholds", {
      quietThreshold: config.attention.scoring.quietThreshold,
      busyThreshold: config.attention.scoring.busyThreshold,
      veryBusyThreshold: config.attention.scoring.veryBusyThreshold,
    }, {
      quietThreshold: DEFAULT_CONFIG.attention.scoring.quietThreshold,
      busyThreshold: DEFAULT_CONFIG.attention.scoring.busyThreshold,
      veryBusyThreshold: DEFAULT_CONFIG.attention.scoring.veryBusyThreshold,
    });
    config.attention.scoring.quietThreshold = DEFAULT_CONFIG.attention.scoring.quietThreshold;
    config.attention.scoring.busyThreshold = DEFAULT_CONFIG.attention.scoring.busyThreshold;
    config.attention.scoring.veryBusyThreshold = DEFAULT_CONFIG.attention.scoring.veryBusyThreshold;
  }

  if (config.tikfinity.reconnect.maxDelayMs < config.tikfinity.reconnect.initialDelayMs) {
    invalid(onDiagnostic, "tikfinity.reconnect", config.tikfinity.reconnect, DEFAULT_CONFIG.tikfinity.reconnect);
    config.tikfinity.reconnect = { ...DEFAULT_CONFIG.tikfinity.reconnect };
  }

  return config;
}
