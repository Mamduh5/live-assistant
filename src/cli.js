#!/usr/bin/env node
import {
  LiveAssistantRuntime,
  LocalControlServer,
  SIMULATOR_SCENARIOS,
  SimulatorConnector,
  TikFinityConnector,
  createJsonLogger,
  loadConfig,
  normalizeTikFinityEnvelope,
  resolveSpeechEngineType,
  resolveAttentionMode,
} from "./index.js";

function option(name) {
  const argumentsAfterScript = process.argv.slice(2);
  const namedIndex = argumentsAfterScript.indexOf(name);
  if (namedIndex >= 0) return argumentsAfterScript[namedIndex + 1];
  const assigned = argumentsAfterScript.find((value) => value.startsWith(`${name}=`));
  return assigned?.slice(name.length + 1);
}

function positionalScenario() {
  const firstArgument = process.argv[2];
  return firstArgument && !firstArgument.startsWith("-") ? firstArgument : undefined;
}

const logger = createJsonLogger();
const configDiagnostics = (diagnostic) => logger.warn(diagnostic.code, diagnostic);
const config = loadConfig(process.env, configDiagnostics);
const connectorChoice = option("--connector") ?? "simulator";
const scenario = option("--scenario") ?? positionalScenario() ?? "quiet-chat";
const includeRaw = config.inspector.includeRaw || process.argv.includes("--include-raw");
const dashboardEnabled = process.argv.includes("--dashboard");
let speechEngineType;
let attentionMode;

try {
  speechEngineType = resolveSpeechEngineType(option("--speech"), config.speechEngine.type);
} catch (error) {
  logger.error("cli.invalid_speech_engine", {
    speechEngine: option("--speech"),
    availableSpeechEngines: ["off", "windows"],
    error: error.message,
  });
  process.exitCode = 1;
}

try {
  attentionMode = resolveAttentionMode(option("--attention"), config.attention.mode);
} catch (error) {
  logger.error("cli.invalid_attention_mode", {
    attentionMode: option("--attention"),
    availableAttentionModes: ["passthrough", "deterministic"],
    error: error.message,
  });
  process.exitCode = 1;
}

let connector;
let normalize;
let runtimeDiagnostic = configDiagnostics;
const relayDiagnostic = (diagnostic) => runtimeDiagnostic(diagnostic);

if (connectorChoice === "simulator") {
  if (!Object.hasOwn(SIMULATOR_SCENARIOS, scenario)) {
    logger.error("cli.invalid_scenario", { scenario, availableScenarios: Object.keys(SIMULATOR_SCENARIOS) });
    process.exitCode = 1;
  } else {
    connector = new SimulatorConnector({ scenario });
  }
} else if (connectorChoice === "tikfinity") {
  connector = new TikFinityConnector({ ...config.tikfinity, onDiagnostic: relayDiagnostic });
  normalize = normalizeTikFinityEnvelope;
} else {
  logger.error("cli.invalid_connector", {
    connector: connectorChoice,
    availableConnectors: ["simulator", "tikfinity"],
  });
  process.exitCode = 1;
}

if (connector && speechEngineType && attentionMode) {
  const runtime = new LiveAssistantRuntime({
    config,
    connector,
    ...(normalize ? { normalize } : {}),
    speechEngineType,
    logger,
    includeRaw,
    attentionMode,
  });
  runtimeDiagnostic = (diagnostic) => runtime.reportDiagnostic(diagnostic);
  let controlServer;
  let releaseDashboard;
  const dashboardLifetime = new Promise((resolve) => { releaseDashboard = resolve; });
  const stop = () => {
    releaseDashboard();
    void controlServer?.stop();
    void runtime.stop();
  };

  process.once("SIGINT", stop);
  try {
    runtime.start();
    if (dashboardEnabled) {
      controlServer = new LocalControlServer({
        runtime,
        ...config.controlServer,
        onDiagnostic: (diagnostic) => runtime.reportDiagnostic(diagnostic),
      });
      try {
        const url = await controlServer.start();
        logger.info("dashboard.available", { url });
      } catch (error) {
        logger.error("control_server.failed", { error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
        await runtime.stop();
        releaseDashboard();
      }
      await dashboardLifetime;
    } else {
      const result = await runtime.waitForCompletion();
      const status = runtime.getStatus();
      logger.info("pipeline.completed", {
        connectorStatus: result.connector.status,
        historySize: status.events.historySize,
        speechQueueSize: status.speech.queueSize,
        speechEngine: status.speech.configuredEngine,
        speechStatus: result.speech.status,
        speechCompleted: result.speech.completed,
        speechFailed: result.speech.failed,
        attentionMode: status.attention.mode,
        attentionDecisions: status.attention.decisionHistorySize,
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    await controlServer?.stop();
    await runtime.stop();
  }
}
