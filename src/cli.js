#!/usr/bin/env node
import {
  DeterministicSpeechPolicy,
  EventHistory,
  LiveEventBus,
  SIMULATOR_SCENARIOS,
  SimulatorConnector,
  SpeechQueue,
  TikFinityConnector,
  createJsonLogger,
  inspectEvent,
  loadConfig,
  normalizeTikFinityEnvelope,
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
  return process.argv.slice(2).find((value) => !value.startsWith("-"));
}

const logger = createJsonLogger();
const diagnostics = (diagnostic) => logger.warn(diagnostic.code, diagnostic);
const config = loadConfig(process.env, diagnostics);
const connectorChoice = option("--connector") ?? "simulator";
const scenario = option("--scenario") ?? positionalScenario() ?? "quiet-chat";
const includeRaw = config.inspector.includeRaw || process.argv.includes("--include-raw");

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

if (connector) {
  const bus = new LiveEventBus({ ...config.eventBus, onDiagnostic: diagnostics });
  const history = new EventHistory(config.eventHistory);
  const speechPolicy = new DeterministicSpeechPolicy(config.speechPolicy);
  const speechQueue = new SpeechQueue({ ...config.speechQueue, onDiagnostic: diagnostics });
  const abortController = new AbortController();
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
  try {
    const result = await runConnector({
      connector,
      ...(normalize ? { normalize } : {}),
      bus,
      signal: abortController.signal,
      logger,
    });
    logger.info("pipeline.completed", {
      connectorStatus: result.status,
      historySize: history.size,
      speechQueueSize: speechQueue.size,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    await connector.close();
  }
}
