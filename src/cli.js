#!/usr/bin/env node
import {
  DeterministicSpeechPolicy,
  EventHistory,
  LiveEventBus,
  SIMULATOR_SCENARIOS,
  SimulatorConnector,
  SpeechQueue,
  createJsonLogger,
  inspectEvent,
  loadConfig,
  runConnector,
} from "./index.js";

function scenarioOption() {
  const argumentsAfterScript = process.argv.slice(2);
  const namedIndex = argumentsAfterScript.indexOf("--scenario");
  if (namedIndex >= 0) return argumentsAfterScript[namedIndex + 1];
  const assigned = argumentsAfterScript.find((value) => value.startsWith("--scenario="));
  if (assigned) return assigned.slice("--scenario=".length);
  return argumentsAfterScript.find((value) => !value.startsWith("-"));
}

const logger = createJsonLogger();
const config = loadConfig(process.env, (diagnostic) => logger.warn(diagnostic.code, diagnostic));
const scenario = scenarioOption() ?? "quiet-chat";

if (!Object.hasOwn(SIMULATOR_SCENARIOS, scenario)) {
  logger.error("cli.invalid_scenario", { scenario, availableScenarios: Object.keys(SIMULATOR_SCENARIOS) });
  process.exitCode = 1;
} else {
  const diagnostics = (diagnostic) => logger.warn(diagnostic.code, diagnostic);
  const bus = new LiveEventBus({ ...config.eventBus, onDiagnostic: diagnostics });
  const history = new EventHistory(config.eventHistory);
  const speechPolicy = new DeterministicSpeechPolicy(config.speechPolicy);
  const speechQueue = new SpeechQueue({ ...config.speechQueue, onDiagnostic: diagnostics });
  const includeRaw = config.inspector.includeRaw || process.argv.includes("--include-raw");

  bus.subscribe((event) => history.record(event));
  bus.subscribe((event) => {
    const decision = speechPolicy.evaluate(event, { queuePressure: speechQueue.pressure });
    const actionResult = decision.action === "queue_speech"
      ? speechQueue.enqueue(decision.request)
      : { accepted: false, reason: decision.reason };
    logger.info("event.inspected", inspectEvent(event, decision, { includeRaw, actionResult }));
  });

  const connector = new SimulatorConnector({ scenario });
  const result = await runConnector({ connector, bus, logger });
  logger.info("pipeline.completed", {
    connectorStatus: result.status,
    historySize: history.size,
    speechQueueSize: speechQueue.size,
  });
}
