#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  DeterministicEventFilter,
  LiveEventBus,
  SIMULATOR_SCENARIOS,
  SimulatorConnector,
  createJsonLogger,
  inspectEvent,
  loadConfig,
  normalizeSimulatorPayload,
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
  logger.error("cli.invalid_scenario", {
    scenario,
    availableScenarios: Object.keys(SIMULATOR_SCENARIOS),
  });
  process.exitCode = 1;
} else {
  const bus = new LiveEventBus({
    ...config.eventBus,
    onDiagnostic: (diagnostic) => logger.warn(diagnostic.code, diagnostic),
  });
  const filter = new DeterministicEventFilter(config.filter);
  bus.subscribe((event) => {
    const decision = filter.evaluate(event);
    logger.info("event.inspected", inspectEvent(event, decision, {
      ...config.inspector,
      includeRaw: config.inspector.includeRaw || process.argv.includes("--include-raw"),
    }));
  });

  const connector = new SimulatorConnector({ scenario });
  await runConnector({
    connector,
    normalize: normalizeSimulatorPayload,
    bus,
    logger,
    idFactory: randomUUID,
  });
}
