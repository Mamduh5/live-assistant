export const DEFAULT_CONFIG = Object.freeze({
  eventBus: Object.freeze({
    maxQueue: 256,
    historyLimit: 100,
  }),
  filter: Object.freeze({
    duplicateWindowMs: 5_000,
    maxTrackedMessages: 500,
    suppressEmptyChat: true,
  }),
  inspector: Object.freeze({
    includeRaw: false,
  }),
});

const ENVIRONMENT_FIELDS = [
  ["LIVE_ASSISTANT_EVENT_QUEUE_LIMIT", "eventBus", "maxQueue"],
  ["LIVE_ASSISTANT_HISTORY_LIMIT", "eventBus", "historyLimit"],
  ["LIVE_ASSISTANT_DUPLICATE_WINDOW_MS", "filter", "duplicateWindowMs"],
  ["LIVE_ASSISTANT_DUPLICATE_TRACKING_LIMIT", "filter", "maxTrackedMessages"],
];

const BOOLEAN_ENVIRONMENT_FIELDS = [
  ["LIVE_ASSISTANT_INSPECT_RAW", "inspector", "includeRaw"],
];

function positiveInteger(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadConfig(environment = process.env, onDiagnostic = () => {}) {
  const config = {
    eventBus: { ...DEFAULT_CONFIG.eventBus },
    filter: { ...DEFAULT_CONFIG.filter },
    inspector: { ...DEFAULT_CONFIG.inspector },
  };

  for (const [environmentName, section, field] of ENVIRONMENT_FIELDS) {
    const parsed = positiveInteger(environment[environmentName]);
    if (parsed === undefined) continue;
    if (parsed === null) {
      onDiagnostic({
        code: "config.invalid",
        field: environmentName,
        value: environment[environmentName],
        fallback: config[section][field],
      });
      continue;
    }
    config[section][field] = parsed;
  }

  for (const [environmentName, section, field] of BOOLEAN_ENVIRONMENT_FIELDS) {
    const value = environment[environmentName];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false") {
      onDiagnostic({
        code: "config.invalid",
        field: environmentName,
        value,
        fallback: config[section][field],
      });
      continue;
    }
    config[section][field] = value === "true";
  }

  return config;
}
