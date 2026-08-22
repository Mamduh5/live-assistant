import { EventHistory } from "../events/event-history.js";
import { LiveEventBus } from "../events/live-event-bus.js";
import { inspectEvent } from "../inspection/event-inspector.js";
import { projectEvent } from "../inspection/event-projection.js";
import { DeterministicSpeechPolicy } from "../speech/deterministic-speech-policy.js";
import { createSpeechEngine } from "../speech/create-speech-engine.js";
import { SpeechQueue } from "../speech/speech-queue.js";
import { SpeechWorker } from "../speech/speech-worker.js";
import { runConnector } from "./run-connector.js";
import { AttentionEngine } from "../attention/attention-engine.js";
import { projectAttentionDecision } from "../inspection/attention-projection.js";
import { OpenAiAttentionProvider } from "../attention/ai-attention-provider.js";

const MAX_API_EVENTS = 200;
const MAX_DIAGNOSTICS = 50;

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function publicDiagnostic(diagnostic, timestamp) {
  const safeFields = [
    "connector", "state", "status", "attempt", "delayMs", "maxQueue", "queueSize",
    "speechRequestId", "eventId", "policy", "droppedEventId", "reason", "batchId",
    "status", "providerCode", "requestId",
  ];
  return Object.fromEntries([
    ["code", typeof diagnostic.code === "string" ? diagnostic.code : "runtime.diagnostic"],
    ["timestamp", timestamp],
    ...safeFields
      .filter((field) => ["string", "number", "boolean"].includes(typeof diagnostic[field]))
      .map((field) => [field, diagnostic[field]]),
  ]);
}

function publicEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return undefined;
  }
}

export class RuntimeControlError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "RuntimeControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class LiveAssistantRuntime {
  #config;
  #connector;
  #normalize;
  #logger;
  #includeRaw;
  #clock;
  #bus;
  #history;
  #attention;
  #attentionOutcomes = new Map();
  #speechPolicy;
  #speechQueue;
  #speechEngineType;
  #speechWorker;
  #abortController;
  #connectorPromise;
  #speechPromise;
  #connectorResult;
  #speechResult;
  #startedAt = null;
  #runtimeState = "idle";
  #connectorState = "idle";
  #subscribers = [];
  #diagnostics = [];
  #unsubscribers = [];
  #stopPromise;
  #drainSpeechOnConnectorCompletion;

  constructor({
    config,
    connector,
    normalize,
    speechEngineType = config.speechEngine.type,
    speechEngine,
    logger = noopLogger(),
    includeRaw = config.inspector.includeRaw,
    clock = Date.now,
    drainSpeechOnConnectorCompletion = connector.name === "simulator",
    attentionMode = config.attention.mode,
    attentionEngine,
    attentionDependencies = {},
    aiProvider,
    openAiApiKey,
  }) {
    if (!connector || typeof connector.events !== "function" || typeof connector.close !== "function") {
      throw new TypeError("LiveAssistantRuntime requires a connector");
    }
    this.#config = config;
    this.#connector = connector;
    this.#normalize = normalize;
    this.#logger = logger;
    this.#includeRaw = includeRaw;
    this.#clock = clock;
    this.#speechEngineType = speechEngineType;
    this.#drainSpeechOnConnectorCompletion = drainSpeechOnConnectorCompletion;

    this.#bus = new LiveEventBus({ ...config.eventBus, onDiagnostic: (value) => this.reportDiagnostic(value) });
    this.#history = new EventHistory(config.eventHistory);
    let resolvedAiProvider = aiProvider;
    if (!attentionEngine && attentionMode === "ai" && !resolvedAiProvider) {
      if (config.attention.ai.provider !== "openai") throw new Error(`Unsupported AI attention provider: ${config.attention.ai.provider}`);
      resolvedAiProvider = new OpenAiAttentionProvider({
        config: config.attention.ai.openai,
        apiKey: openAiApiKey,
        clock,
      });
    }
    this.#attention = attentionEngine ?? new AttentionEngine({
      config: config.attention,
      mode: attentionMode,
      clock,
      onDiagnostic: (value) => this.reportDiagnostic(value),
      ...(resolvedAiProvider ? { aiProvider: resolvedAiProvider } : {}),
      ...attentionDependencies,
    });
    this.#speechPolicy = new DeterministicSpeechPolicy(config.speechPolicy);
    this.#speechQueue = new SpeechQueue({ ...config.speechQueue, onDiagnostic: (value) => this.reportDiagnostic(value) });
    const engine = speechEngine === undefined
      ? createSpeechEngine({ type: speechEngineType, config: config.speechEngine, onDiagnostic: (value) => this.reportDiagnostic(value) })
      : speechEngine;
    this.#speechWorker = engine
      ? new SpeechWorker({ queue: this.#speechQueue, engine, onDiagnostic: (value) => this.reportDiagnostic(value) })
      : null;

    this.#unsubscribers.push(this.#bus.subscribe((event) => this.#handleEvent(event)));
    this.#unsubscribers.push(this.#attention.subscribe((decision) => this.#handleAttentionDecision(decision)));
    if (typeof this.#attention.subscribeState === "function") {
      this.#unsubscribers.push(this.#attention.subscribeState((state) => this.#emit("attention-state", state)));
    }
    if (typeof connector.subscribeState === "function") {
      this.#unsubscribers.push(connector.subscribeState((state) => {
        this.#connectorState = state;
        this.#emit("connector-state", this.getStatus().connector);
      }));
    }
    if (this.#speechWorker) {
      this.#unsubscribers.push(this.#speechWorker.subscribeState(() => {
        this.#emit("speech-state", this.getStatus().speech);
      }));
    }
  }

  start() {
    if (this.#runtimeState === "running") return this.getStatus();
    if (this.#runtimeState !== "idle") throw new RuntimeControlError("runtime_not_startable", "Runtime cannot be restarted");
    this.#runtimeState = "running";
    this.#startedAt = this.#clock();
    this.#abortController = new AbortController();
    this.#speechPromise = this.#speechWorker?.run(this.#abortController.signal);
    this.#emit("runtime-state", this.getStatus());
    this.#connectorPromise = this.#runConnector();
    return this.getStatus();
  }

  async #runConnector() {
    const result = await runConnector({
      connector: this.#connector,
      ...(this.#normalize ? { normalize: this.#normalize } : {}),
      bus: this.#bus,
      signal: this.#abortController.signal,
      logger: this.#logger,
    });
    this.#connectorResult = result;
    if (!this.#abortController.signal.aborted) await this.#attention.flush();
    if (this.#drainSpeechOnConnectorCompletion && !this.#abortController.signal.aborted) {
      this.#speechResult = this.#speechWorker
        ? await this.#speechWorker.drain()
        : { status: "off", completed: 0, failed: 0 };
    }
    this.#emit("runtime-state", this.getStatus());
    return result;
  }

  async waitForCompletion() {
    if (!this.#connectorPromise) throw new RuntimeControlError("runtime_not_started", "Runtime has not started");
    const connector = await this.#connectorPromise;
    if (!this.#speechResult && this.#speechWorker && !this.#abortController.signal.aborted) {
      this.#speechResult = await this.#speechWorker.drain();
    }
    if (!this.#speechResult) this.#speechResult = { status: "off", completed: 0, failed: 0 };
    return { connector, speech: this.#speechResult };
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop() {
    if (this.#runtimeState === "stopped") return;
    this.#runtimeState = "stopping";
    this.#abortController?.abort();
    try {
      await this.#connector.close();
    } catch {
      this.reportDiagnostic({ code: "connector.close_failed", connector: this.#connector.name });
    }
    await this.#attention.close();
    if (this.#speechWorker) this.#speechResult = await this.#speechWorker.cancel();
    else this.#speechQueue.close();
    if (this.#connectorPromise) await this.#connectorPromise;
    this.#runtimeState = "stopped";
    this.#emit("runtime-state", this.getStatus());
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#subscribers.length = 0;
  }

  pauseSpeech() {
    const worker = this.#requireSpeech();
    this.#attention.suppressPendingSpeech();
    worker.pause();
    return this.getStatus().speech;
  }

  resumeSpeech() {
    const worker = this.#requireSpeech();
    worker.resume();
    return this.getStatus().speech;
  }

  clearSpeechQueue() {
    this.#requireSpeech();
    const cleared = this.#speechQueue.clear();
    this.reportDiagnostic({ code: "speech_queue.cleared", queueSize: this.#speechQueue.size });
    this.#emit("speech-state", this.getStatus().speech);
    return { cleared, queueSize: this.#speechQueue.size };
  }

  cancelCurrentSpeech() {
    const worker = this.#requireSpeech();
    const cancelled = worker.cancelCurrent();
    return { cancelled, currentRequestId: worker.getStatus().currentRequestId };
  }

  #requireSpeech() {
    if (!this.#speechWorker) throw new RuntimeControlError("speech_not_available", "Speech is not enabled");
    const { state } = this.#speechWorker.getStatus();
    if (state === "stopped" || state === "error") {
      throw new RuntimeControlError("speech_not_available", "Speech worker is not available");
    }
    return this.#speechWorker;
  }

  getStatus() {
    const workerStatus = this.#speechWorker?.getStatus();
    return {
      runtime: { state: this.#runtimeState, startedAt: this.#startedAt },
      connector: {
        name: this.#connector.name,
        state: this.#connectorState,
        ...(this.#connector.name === "tikfinity" ? { endpoint: publicEndpoint(this.#config.tikfinity.url) } : {}),
        ...(this.#connector.name === "tiktok-browser" ? {
          endpoint: publicEndpoint(this.#config.tiktokBrowser.cdpUrl),
          ...(this.#connector.counters ? { counters: this.#connector.counters } : {}),
          ...(this.#connector.recovery ? { recovery: this.#connector.recovery } : {}),
          ...(this.#connector.navigation ? { navigation: this.#connector.navigation } : {}),
        } : {}),
      },
      speech: {
        configuredEngine: this.#speechEngineType,
        enabled: Boolean(this.#speechWorker),
        paused: workerStatus?.paused ?? false,
        workerState: workerStatus?.state ?? "off",
        queueSize: this.#speechQueue.size,
        currentRequestId: workerStatus?.currentRequestId ?? null,
        ...(this.#speechEngineType === "windows" ? {
          voice: this.#config.speechEngine.windows.voice,
          rate: this.#config.speechEngine.windows.rate,
          volume: this.#config.speechEngine.windows.volume,
        } : {}),
      },
      events: { historySize: this.#history.size, rawInspectionEnabled: this.#includeRaw },
      attention: this.#attention.getStatus(),
    };
  }

  getRecentEvents({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Event limit must be a non-negative integer");
    const boundedLimit = Math.min(limit, MAX_API_EVENTS);
    return this.#history.getEvents({ limit: boundedLimit }).map((event) => projectEvent(event, { includeRaw: this.#includeRaw }));
  }

  getRecentDiagnostics(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Diagnostic limit must be a non-negative integer");
    return this.#diagnostics.slice(-Math.min(limit, MAX_DIAGNOSTICS)).map((item) => ({ ...item }));
  }

  getRecentAttention({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Attention limit must be a non-negative integer");
    return this.#attention.getRecentDecisions({ limit: Math.min(limit, 200) }).map((decision) => projectAttentionDecision(decision, {
      speech: this.#attentionOutcomes.get(decision.id),
    }));
  }

  getSnapshot() {
    return {
      status: this.getStatus(),
      events: this.getRecentEvents({ limit: 100 }),
      attention: this.getRecentAttention({ limit: 100 }),
      diagnostics: this.getRecentDiagnostics(),
    };
  }

  subscribe(handler) {
    if (typeof handler !== "function") throw new TypeError("Runtime subscriber must be a function");
    this.#subscribers.push(handler);
    return () => {
      const index = this.#subscribers.indexOf(handler);
      if (index >= 0) this.#subscribers.splice(index, 1);
    };
  }

  reportDiagnostic(diagnostic) {
    const projected = publicDiagnostic(diagnostic, this.#clock());
    this.#diagnostics.push(projected);
    if (this.#diagnostics.length > MAX_DIAGNOSTICS) this.#diagnostics.shift();
    this.#logger.warn(projected.code, diagnostic);
    this.#emit("diagnostic", projected);
  }

  #handleEvent(event) {
    this.#history.record(event);
    this.#emit("live-event", projectEvent(event, { includeRaw: this.#includeRaw }));
    const paused = this.#speechWorker?.getStatus().paused === true;
    const attentionDecision = this.#attention.observe(event, {
      speechEligible: Boolean(this.#speechWorker) && !paused,
    });
    const inspectionDecision = attentionDecision
      ? { action: attentionDecision.action, priority: attentionDecision.priority, reason: attentionDecision.reason }
      : { action: "defer", priority: 0, reason: "attention_group_pending" };
    this.#logger.info("event.inspected", inspectEvent(event, inspectionDecision, { includeRaw: this.#includeRaw }));
    this.#emit("speech-state", this.getStatus().speech);
  }

  #handleAttentionDecision(decision) {
    let speechDecision;
    let actionResult;
    if (decision.action !== "promote" || !decision.candidate) {
      actionResult = { accepted: false, reason: "attention_ignored" };
    } else if (!this.#speechWorker) {
      actionResult = { accepted: false, reason: "speech_off" };
    } else if (!decision.candidate.speechEligible || this.#speechWorker.getStatus().paused) {
      actionResult = { accepted: false, reason: "speech_paused" };
    } else {
      speechDecision = this.#speechPolicy.evaluateCandidate(decision.candidate, { queuePressure: this.#speechQueue.pressure });
      actionResult = speechDecision.action === "queue_speech"
        ? this.#speechQueue.enqueue(speechDecision.request)
        : { accepted: false, reason: speechDecision.reason };
    }
    const speech = {
      decision: speechDecision ? {
        action: speechDecision.action,
        priority: speechDecision.priority,
        reason: speechDecision.reason,
      } : null,
      actionResult,
    };
    this.#attentionOutcomes.set(decision.id, speech);
    while (this.#attentionOutcomes.size > this.#config.attention.decisionHistoryLimit) {
      this.#attentionOutcomes.delete(this.#attentionOutcomes.keys().next().value);
    }
    this.#emit("attention-decision", projectAttentionDecision(decision, { speech }));
    this.#emit("speech-state", this.getStatus().speech);
  }

  #emit(type, data) {
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber({ type, data });
      } catch (error) {
        this.#logger.warn("runtime.subscriber_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
