import {
  LiveAssistantRuntime,
  LocalControlServer,
  SimulatorConnector,
  AiProviderError,
  createJsonLogger,
  loadConfig,
} from "../src/index.js";

class SyntheticSemanticProvider {
  #closed = false;
  #requests = 0;
  #successes = 0;
  #failures = 0;

  async analyzeBatch(batch) {
    this.#requests += 1;
    const ids = batch.items.map(({ itemId }) => itemId);
    if (this.#requests === 2) {
      this.#failures += 1;
      throw new AiProviderError("provider_network_error", "Synthetic fallback fixture");
    }
    this.#successes += 1;
    return {
      groups: [
        { itemIds: ids.slice(0, 3), classification: "question", importance: 85, reason: "semantic_question_group", summary: "What weapon are you using?" },
        { itemIds: ids.slice(3), classification: "question", importance: 78, reason: "semantic_question_group", summary: "Where did you find the chest?" },
      ],
    };
  }

  getStatus() {
    return {
      name: "synthetic", model: "offline-semantic-fixture",
      state: this.#closed ? "unavailable" : "healthy",
      requests: this.#requests, successes: this.#successes, failures: this.#failures,
      inputTokens: 0, outputTokens: 0, lastLatencyMs: 0,
    };
  }

  async close() { this.#closed = true; }
}

const logger = createJsonLogger();
const config = loadConfig({
  LIVE_ASSISTANT_ATTENTION_MODE: "ai",
  LIVE_ASSISTANT_SPEECH_ENGINE: "off",
});
config.attention.ai.maxBatchMessages = 5;
const runtime = new LiveAssistantRuntime({
  config,
  connector: new SimulatorConnector({ scenario: "attention-semantic-burst" }),
  speechEngineType: "off",
  speechEngine: null,
  attentionMode: "ai",
  aiProvider: new SyntheticSemanticProvider(),
  logger,
});
const server = new LocalControlServer({ runtime, ...config.controlServer });
let release;
const stopped = new Promise((resolve) => { release = resolve; });
const stop = () => release();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  runtime.start();
  const url = await server.start();
  logger.info("dashboard.ai_fixture_available", { url, fixture: "synthetic" });
  await stopped;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await server.stop();
  await runtime.stop();
}
