#!/usr/bin/env node
import {
  DeterministicSpeechPolicy,
  EventHistory,
  LiveEventBus,
  SIMULATOR_SCENARIOS,
  SimulatorConnector,
  SpeechQueue,
  SpeechWorker,
  TikFinityConnector,
  createSpeechEngine,
  createJsonLogger,
  inspectEvent,
  loadConfig,
  normalizeTikFinityEnvelope,
  resolveSpeechEngineType,
  runConnector,
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
const diagnostics = (diagnostic) => logger.warn(diagnostic.code, diagnostic);
const config = loadConfig(process.env, diagnostics);
const connectorChoice = option("--connector") ?? "simulator";
const scenario = option("--scenario") ?? positionalScenario() ?? "quiet-chat";
const includeRaw = config.inspector.includeRaw || process.argv.includes("--include-raw");
let speechEngineType;

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

let connector;
let normalize;

if (connectorChoice === "simulator") {
  if (!Object.hasOwn(SIMULATOR_SCENARIOS, scenario)) {
    logger.error("cli.invalid_scenario", { scenario, availableScenarios: Object.keys(SIMULATOR_SCENARIOS) });
    process.exitCode = 1;
  } else {
    connector = new SimulatorConnector({ scenario });
  }
} else if (connectorChoice === "tikfinity") {
  connector = new TikFinityConnector({
    ...config.tikfinity,
    onDiagnostic: diagnostics,
  });
  normalize = normalizeTikFinityEnvelope;
} else {
  logger.error("cli.invalid_connector", {
    connector: connectorChoice,
    availableConnectors: ["simulator", "tikfinity"],
  });
  process.exitCode = 1;
}

if (connector && speechEngineType) {
  const bus = new LiveEventBus({ ...config.eventBus, onDiagnostic: diagnostics });
  const history = new EventHistory(config.eventHistory);
  const speechPolicy = new DeterministicSpeechPolicy(config.speechPolicy);
  const speechQueue = new SpeechQueue({ ...config.speechQueue, onDiagnostic: diagnostics });
  const speechEngine = createSpeechEngine({ type: speechEngineType, config: config.speechEngine });
  const abortController = new AbortController();
  const speechWorker = speechEngine
    ? new SpeechWorker({ queue: speechQueue, engine: speechEngine, onDiagnostic: diagnostics })
    : null;
  const stop = () => {
    abortController.abort();
    void connector.close();
  };

  bus.subscribe((event) => history.record(event));
  bus.subscribe((event) => {
    const decision = speechPolicy.evaluate(event, { queuePressure: speechQueue.pressure });
    const actionResult = decision.action === "queue_speech"
      ? speechQueue.enqueue(decision.request)
      : { accepted: false, reason: decision.reason };
    logger.info("event.inspected", inspectEvent(event, decision, { includeRaw, actionResult }));
  });

  process.once("SIGINT", stop);
  speechWorker?.run(abortController.signal);
  try {
    const result = await runConnector({
      connector,
      ...(normalize ? { normalize } : {}),
      bus,
      signal: abortController.signal,
      logger,
    });
    let speechResult;
    if (speechWorker) {
      speechResult = await (abortController.signal.aborted ? speechWorker.cancel() : speechWorker.drain());
    } else {
      speechQueue.close();
      speechResult = { status: "off", completed: 0, failed: 0 };
    }
    logger.info("pipeline.completed", {
      connectorStatus: result.status,
      historySize: history.size,
      speechQueueSize: speechQueue.size,
      speechEngine: speechEngineType,
      speechStatus: speechResult.status,
      speechCompleted: speechResult.completed,
      speechFailed: speechResult.failed,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    if (speechWorker && !speechQueue.closed) await speechWorker.cancel();
    await connector.close();
  }
}
