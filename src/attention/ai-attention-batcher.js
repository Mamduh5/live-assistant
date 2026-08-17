import { validateAiAnalysis, AiProviderError } from "./ai-attention-provider.js";
import {
  formatQuestionText,
  normalizeExactQuestion,
  speechUserId,
  stableUserKey,
} from "./deterministic-attention-policy.js";

function errorCode(error) {
  return error instanceof AiProviderError ? error.code : "provider_failed";
}

export class AiAttentionBatcher {
  #config;
  #provider;
  #clock;
  #setTimeout;
  #clearTimeout;
  #onResult;
  #onFallback;
  #onDiagnostic;
  #onStateChange;
  #itemSequence = 0;
  #batchSequence = 0;
  #current;
  #timer;
  #pending = [];
  #activeBatch;
  #activePromise;
  #activeController;
  #closed = false;
  #idleWaiters = [];
  #requestTimes = [];
  #consecutiveFailures = 0;
  #circuitOpenedAt;
  #fallbacks = 0;
  #rateBudgetFallbacks = 0;
  #circuitFallbacks = 0;

  constructor({
    config,
    provider,
    clock = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onResult,
    onFallback,
    onDiagnostic = () => {},
    onStateChange = () => {},
  }) {
    if (!provider || typeof provider.analyzeBatch !== "function" || typeof provider.getStatus !== "function" || typeof provider.close !== "function") {
      throw new TypeError("AI attention mode requires an AI attention provider");
    }
    this.#config = config;
    this.#provider = provider;
    this.#clock = clock;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#onResult = onResult;
    this.#onFallback = onFallback;
    this.#onDiagnostic = onDiagnostic;
    this.#onStateChange = onStateChange;
  }

  observe(event, { classification, speechEligible }) {
    if (this.#closed) return;
    const text = formatQuestionText(event.data.text);
    const key = normalizeExactQuestion(event.data.text);
    if (text.length > this.#config.maxBatchChars) {
      const identity = stableUserKey(event.user);
      this.#fallback({
        id: `batch-${++this.#batchSequence}`,
        createdAt: event.receivedAt,
        sealedAt: this.#clock(),
        sourceMessages: 1,
        characters: text.length,
        items: [{
          itemId: `item-${++this.#itemSequence}`,
          key,
          text,
          classificationHint: classification,
          occurrences: 1,
          users: new Map(identity ? [[identity, speechUserId(event.user)]] : []),
          sourceEventIds: [event.id],
          primaryEventId: event.id,
          speechEligible,
          firstReceivedAt: event.receivedAt,
          lastReceivedAt: event.receivedAt,
        }],
      }, "batch_item_too_large");
      return;
    }
    const isNewItem = !this.#current?.itemsByKey.has(key);
    if (this.#current && (
      this.#current.sourceMessages >= this.#config.maxBatchMessages ||
      (isNewItem && this.#current.itemsByKey.size >= this.#config.maxBatchItems) ||
      (isNewItem && this.#current.characters + text.length > this.#config.maxBatchChars)
    )) {
      this.#sealCurrent();
    }
    if (!this.#current) this.#startBatch(event.receivedAt);
    const existing = this.#current.itemsByKey.get(key);
    const identity = stableUserKey(event.user);
    if (existing) {
      existing.occurrences += 1;
      existing.sourceEventIds.push(event.id);
      if (identity) existing.users.set(identity, speechUserId(event.user));
      existing.speechEligible &&= speechEligible;
      existing.lastReceivedAt = Math.max(existing.lastReceivedAt, event.receivedAt);
    } else {
      const item = {
        itemId: `item-${++this.#itemSequence}`,
        key,
        text,
        classificationHint: classification,
        occurrences: 1,
        users: new Map(identity ? [[identity, speechUserId(event.user)]] : []),
        sourceEventIds: [event.id],
        primaryEventId: event.id,
        speechEligible,
        firstReceivedAt: event.receivedAt,
        lastReceivedAt: event.receivedAt,
      };
      this.#current.itemsByKey.set(key, item);
      this.#current.characters += text.length;
    }
    this.#current.sourceMessages += 1;
    if (this.#current.timerFailed || this.#current.sourceMessages >= this.#config.maxBatchMessages) this.#sealCurrent();
    this.#stateChanged();
  }

  #startBatch(createdAt) {
    const deadline = this.#clock() + this.#config.batchWindowMs;
    this.#current = {
      id: `batch-${++this.#batchSequence}`,
      createdAt,
      deadline,
      characters: 0,
      sourceMessages: 0,
      itemsByKey: new Map(),
    };
    try {
      this.#timer = this.#setTimeout(() => {
        this.#timer = undefined;
        this.#sealCurrent();
      }, this.#config.batchWindowMs);
    } catch (error) {
      this.#diagnostic({ code: "attention.ai.timer_failed" });
      this.#timer = undefined;
      this.#current.timerFailed = true;
    }
  }

  #sealCurrent() {
    if (!this.#current || this.#current.sourceMessages === 0) return;
    this.#cancelTimer();
    const batch = {
      id: this.#current.id,
      createdAt: this.#current.createdAt,
      sealedAt: this.#clock(),
      sourceMessages: this.#current.sourceMessages,
      characters: this.#current.characters,
      items: [...this.#current.itemsByKey.values()],
    };
    this.#current = undefined;
    if (this.#pending.length >= this.#config.maxPendingBatches) {
      const overflowed = this.#pending.shift();
      this.#diagnostic({ code: "attention.ai.batch_overflow", batchId: overflowed.id });
      this.#fallback(overflowed, "batch_overflow");
    }
    this.#pending.push(batch);
    this.#pump();
    this.#stateChanged();
  }

  #pump() {
    if (this.#closed || this.#activePromise || this.#pending.length === 0) {
      this.#resolveIdleIfNeeded();
      return;
    }
    const batch = this.#pending.shift();
    this.#activeBatch = batch;
    this.#activePromise = this.#process(batch)
      .catch(() => {})
      .finally(() => {
        this.#activeBatch = undefined;
        this.#activePromise = undefined;
        this.#stateChanged();
        this.#pump();
      });
    this.#stateChanged();
  }

  async #process(batch) {
    const now = this.#clock();
    if (this.#circuitOpenedAt !== undefined && now - this.#circuitOpenedAt < this.#config.circuitCooldownMs) {
      this.#circuitFallbacks += 1;
      this.#fallback(batch, "circuit_open");
      return;
    }
    this.#pruneBudget(now);
    if (this.#requestTimes.length >= this.#config.requestsPerMinute) {
      this.#rateBudgetFallbacks += 1;
      this.#diagnostic({ code: "attention.ai.rate_budget_exceeded" });
      this.#fallback(batch, "rate_budget_exceeded");
      return;
    }
    this.#requestTimes.push(now);
    const safeBatch = {
      items: batch.items.map((item) => ({
        itemId: item.itemId,
        text: item.text,
        occurrences: item.occurrences,
        knownUniqueViewers: item.users.size,
        classificationHint: item.classificationHint,
      })),
      maxSummaryChars: this.#config.maxSummaryChars,
    };
    try {
      this.#activeController = new AbortController();
      const analysis = await this.#provider.analyzeBatch(safeBatch, { signal: this.#activeController.signal });
      validateAiAnalysis(analysis, safeBatch.items.map(({ itemId }) => itemId), {
        maxSummaryChars: this.#config.maxSummaryChars,
      });
      if (this.#closed) return;
      if (this.#circuitOpenedAt !== undefined) this.#diagnostic({ code: "attention.ai.circuit_recovered" });
      this.#circuitOpenedAt = undefined;
      this.#consecutiveFailures = 0;
      this.#onResult(batch, analysis);
    } catch (error) {
      if (this.#closed) return;
      const reason = errorCode(error);
      const safeMetadata = error instanceof AiProviderError ? error.metadata : {};
      this.#consecutiveFailures += 1;
      this.#diagnostic({
        code: reason === "provider_timeout" ? "attention.ai.timeout" : reason === "provider_invalid_response" ? "attention.ai.invalid_response" : "attention.ai.request_failed",
        reason,
        ...safeMetadata,
      });
      if (this.#consecutiveFailures >= this.#config.failureThreshold) {
        this.#circuitOpenedAt = this.#clock();
        this.#diagnostic({ code: "attention.ai.circuit_open" });
      }
      this.#fallback(batch, reason);
    } finally {
      this.#activeController = undefined;
    }
  }

  #fallback(batch, reason) {
    if (this.#closed) return;
    this.#fallbacks += 1;
    this.#diagnostic({ code: "attention.ai.fallback", reason });
    this.#onFallback(batch, reason);
    this.#stateChanged();
  }

  #pruneBudget(now) {
    const cutoff = now - 60_000;
    while (this.#requestTimes.length > 0 && this.#requestTimes[0] <= cutoff) this.#requestTimes.shift();
  }

  suppressPendingSpeech() {
    const batches = [this.#current, ...this.#pending, this.#activeBatch].filter(Boolean);
    for (const batch of batches) {
      const items = batch.items ?? [...batch.itemsByKey.values()];
      for (const item of items) item.speechEligible = false;
    }
  }

  async flush() {
    if (this.#closed) return;
    this.#sealCurrent();
    if (!this.#activePromise && this.#pending.length === 0) return;
    await new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    this.#current = undefined;
    this.#pending.length = 0;
    this.#activeController?.abort();
    await this.#provider.close();
    if (this.#activePromise) await this.#activePromise;
    this.#resolveIdleIfNeeded();
    this.#stateChanged();
  }

  getStatus() {
    const provider = this.#provider.getStatus();
    const now = this.#clock();
    const circuitOpen = this.#circuitOpenedAt !== undefined && now - this.#circuitOpenedAt < this.#config.circuitCooldownMs;
    return {
      ...provider,
      state: circuitOpen ? "circuit_open" : provider.state,
      inFlight: this.#activePromise ? 1 : 0,
      pendingBatches: this.#pending.length,
      currentBatchMessages: this.#current?.sourceMessages ?? 0,
      fallbackCount: this.#fallbacks,
      rateBudgetFallbacks: this.#rateBudgetFallbacks,
      circuitFallbacks: this.#circuitFallbacks,
      requestsInWindow: (this.#pruneBudget(now), this.#requestTimes.length),
    };
  }

  #cancelTimer() {
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #resolveIdleIfNeeded() {
    if (this.#activePromise || this.#pending.length > 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }

  #diagnostic(value) {
    try { this.#onDiagnostic(value); } catch { /* diagnostics cannot break batching */ }
  }

  #stateChanged() {
    try { this.#onStateChange(this.getStatus()); } catch { /* status observers are isolated */ }
  }
}
