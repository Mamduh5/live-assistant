import { randomUUID } from "node:crypto";
import { assertLiveEvent, LiveEventType } from "../events/live-event.js";
import {
  AttentionAction,
  AttentionClassification,
  assertAttentionDecision,
} from "./attention-contracts.js";
import {
  DeterministicAttentionPolicy,
  formatQuestionText,
  normalizeExactQuestion,
  speechUserId,
  stableUserKey,
} from "./deterministic-attention-policy.js";

const MODES = new Set(["passthrough", "deterministic"]);

export function resolveAttentionMode(requestedMode, configuredMode = "passthrough") {
  const mode = requestedMode ?? configuredMode;
  if (!MODES.has(mode)) throw new RangeError(`Unsupported attention mode: ${mode}`);
  return mode;
}

function validateConfig(config) {
  for (const field of ["recentWindowMs", "maxRecentMessages", "groupWindowMs", "maxPendingGroups", "decisionHistoryLimit"]) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new RangeError(`attention.${field} must be a positive integer`);
  }
  const scoringFields = [
    "messageBase", "questionBase", "lowInformationBase", "repeatedQuestionBonusPerUser",
    "repeatedQuestionBonusCap", "quietThreshold", "busyThreshold", "veryBusyThreshold",
  ];
  for (const field of scoringFields) {
    if (!Number.isFinite(config.scoring[field]) || config.scoring[field] < 0 || config.scoring[field] > 100) {
      throw new RangeError(`attention.scoring.${field} must be between 0 and 100`);
    }
  }
  if (!Number.isSafeInteger(config.scoring.busyMessageCount) || config.scoring.busyMessageCount < 1) throw new RangeError("attention busy count must be positive");
  if (!Number.isSafeInteger(config.scoring.veryBusyMessageCount) || config.scoring.veryBusyMessageCount <= config.scoring.busyMessageCount) {
    throw new RangeError("attention very-busy count must exceed busy count");
  }
  if (!(
    config.scoring.quietThreshold <= config.scoring.busyThreshold &&
    config.scoring.busyThreshold <= config.scoring.veryBusyThreshold
  )) {
    throw new RangeError("attention thresholds must be ordered quiet <= busy <= very-busy");
  }
}

export class AttentionEngine {
  #config;
  #mode;
  #policy;
  #clock;
  #setTimeout;
  #clearTimeout;
  #onDiagnostic;
  #failureIdFactory;
  #recent = [];
  #latestReceivedAt = 0;
  #groups = new Map();
  #decisions = [];
  #subscribers = [];
  #timer;
  #timerDeadline;
  #closed = false;

  constructor({
    config,
    mode = config.mode,
    policy,
    clock = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onDiagnostic = () => {},
    policyDependencies = {},
    failureIdFactory = randomUUID,
  }) {
    validateConfig(config);
    this.#config = config;
    this.#mode = resolveAttentionMode(mode, config.mode);
    this.#policy = policy ?? new DeterministicAttentionPolicy(config, policyDependencies);
    this.#clock = clock;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#onDiagnostic = onDiagnostic;
    this.#failureIdFactory = failureIdFactory;
  }

  observe(event, { speechEligible = true } = {}) {
    assertLiveEvent(event);
    if (this.#closed) return null;
    try {
      const classification = this.#policy.classify(event);
      const trafficLevel = this.#recordRecent(event, classification);
      if (
        this.#mode === "deterministic" &&
        classification === AttentionClassification.QUESTION
      ) {
        this.#addQuestion(event, { speechEligible });
        return null;
      }
      const identity = stableUserKey(event.user);
      const decision = this.#policy.decide({
        mode: this.#mode,
        classification,
        representativeText: event.type === LiveEventType.CHAT_MESSAGE
          ? event.data.text.trim().replace(/\s+/gu, " ")
          : event.type,
        sourceEventIds: [event.id],
        primaryEventId: event.id,
        userId: speechUserId(event.user),
        group: null,
        trafficLevel,
        createdAt: event.receivedAt,
        speechEligible,
      });
      this.#recordDecision(decision);
      return decision;
    } catch (error) {
      this.#diagnostic({ code: "attention.policy_failed", eventId: event.id, error: error instanceof Error ? error.message : String(error) });
      const decision = this.#failureDecision({
        createdAt: event.receivedAt,
        classification: event.type === LiveEventType.CHAT_MESSAGE
          ? AttentionClassification.MESSAGE
          : AttentionClassification.NON_CHAT,
        primaryEventId: event.id,
        sourceEventIds: [event.id],
      });
      this.#recordDecision(decision);
      return decision;
    }
  }

  #recordRecent(event, classification) {
    if (event.type !== LiveEventType.CHAT_MESSAGE) return this.#trafficLevel(this.#latestReceivedAt);
    this.#latestReceivedAt = Math.max(this.#latestReceivedAt, event.receivedAt);
    this.#pruneRecent(this.#latestReceivedAt);
    const cutoff = this.#latestReceivedAt - this.#config.recentWindowMs;
    if (event.receivedAt >= cutoff) {
      const recentEntry = {
        eventId: event.id,
        receivedAt: event.receivedAt,
        userKey: stableUserKey(event.user),
        normalizedText: event.data.text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und"),
        classification,
      };
      let insertionIndex = this.#recent.length;
      while (insertionIndex > 0 && this.#recent[insertionIndex - 1].receivedAt > event.receivedAt) {
        insertionIndex -= 1;
      }
      this.#recent.splice(insertionIndex, 0, recentEntry);
      while (this.#recent.length > this.#config.maxRecentMessages) this.#recent.shift();
    }
    return this.#trafficLevel(this.#latestReceivedAt);
  }

  #pruneRecent(now) {
    const cutoff = now - this.#config.recentWindowMs;
    while (this.#recent.length > 0 && this.#recent[0].receivedAt < cutoff) this.#recent.shift();
  }

  #trafficLevel(now) {
    this.#pruneRecent(now);
    if (this.#recent.length >= this.#config.scoring.veryBusyMessageCount) return "very_busy";
    if (this.#recent.length >= this.#config.scoring.busyMessageCount) return "busy";
    return "quiet";
  }

  #addQuestion(event, { speechEligible }) {
    const key = normalizeExactQuestion(event.data.text);
    const existing = this.#groups.get(key);
    const identity = stableUserKey(event.user);
    if (existing) {
      existing.occurrences += 1;
      if (existing.sourceEventIds.length < this.#config.maxRecentMessages) {
        existing.sourceEventIds.push(event.id);
      } else if (!existing.membersBounded) {
        existing.membersBounded = true;
        this.#diagnostic({
          code: "attention.group_member_overflow",
          groupKey: key,
          maxMembers: this.#config.maxRecentMessages,
        });
      }
      if (
        identity &&
        (existing.users.has(identity) || existing.users.size < this.#config.maxRecentMessages)
      ) {
        existing.users.set(identity, speechUserId(event.user));
      }
      existing.speechEligible &&= speechEligible;
      return;
    }

    if (this.#groups.size >= this.#config.maxPendingGroups) {
      const oldest = this.#groups.values().next().value;
      this.#diagnostic({ code: "attention.group_overflow", maxPendingGroups: this.#config.maxPendingGroups });
      this.#flushGroup(oldest, oldest.deadline);
    }

    const firstSeen = event.receivedAt;
    this.#groups.set(key, {
      key,
      representativeText: formatQuestionText(event.data.text),
      primaryEventId: event.id,
      sourceEventIds: [event.id],
      occurrences: 1,
      users: new Map(identity ? [[identity, speechUserId(event.user)]] : []),
      firstSeen,
      deadline: firstSeen + this.#config.groupWindowMs,
      speechEligible,
      membersBounded: false,
    });
    this.#scheduleNextTimer();
  }

  #scheduleNextTimer() {
    if (this.#closed || this.#groups.size === 0) return;
    const nextDeadline = Math.min(...[...this.#groups.values()].map(({ deadline }) => deadline));
    if (this.#timer !== undefined && this.#timerDeadline <= nextDeadline) return;
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    this.#timerDeadline = nextDeadline;
    const delay = Math.max(0, nextDeadline - this.#clock());
    try {
      this.#timer = this.#setTimeout(() => {
        this.#timer = undefined;
        this.#timerDeadline = undefined;
        try {
          this.#flushDue(nextDeadline);
        } catch (error) {
          this.#diagnostic({ code: "attention.timer_failed", error: error instanceof Error ? error.message : String(error) });
        }
      }, delay);
    } catch (error) {
      this.#timer = undefined;
      this.#timerDeadline = undefined;
      this.#diagnostic({ code: "attention.timer_failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  #flushDue(now) {
    if (this.#closed) return;
    for (const group of [...this.#groups.values()]) {
      if (group.deadline <= now) this.#flushGroup(group, group.deadline);
    }
    this.#scheduleNextTimer();
  }

  #flushGroup(group, createdAt) {
    if (!group || !this.#groups.delete(group.key) || this.#closed) return null;
    const users = [...group.users.values()];
    const publicGroup = {
      key: group.key,
      representativeText: group.representativeText,
      occurrences: group.occurrences,
      uniqueUsers: users.length,
      firstSeen: group.firstSeen,
      deadline: group.deadline,
    };
    let decision;
    try {
      decision = this.#policy.decide({
        mode: this.#mode,
        classification: AttentionClassification.QUESTION,
        representativeText: group.representativeText,
        sourceEventIds: group.sourceEventIds,
        primaryEventId: group.primaryEventId,
        userId: users.length === 1 ? users[0] : undefined,
        group: publicGroup,
        trafficLevel: this.#trafficLevel(createdAt),
        createdAt,
        speechEligible: group.speechEligible,
      });
    } catch (error) {
      this.#diagnostic({
        code: "attention.policy_failed",
        eventId: group.primaryEventId,
        error: error instanceof Error ? error.message : String(error),
      });
      decision = this.#failureDecision({
        createdAt,
        classification: AttentionClassification.QUESTION,
        primaryEventId: group.primaryEventId,
        sourceEventIds: group.sourceEventIds,
        group: publicGroup,
      });
    }
    this.#recordDecision(decision);
    return decision;
  }

  async flush() {
    if (this.#closed) return [];
    this.#cancelTimer();
    const decisions = [];
    for (const group of [...this.#groups.values()]) {
      const decision = this.#flushGroup(group, group.deadline);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  suppressPendingSpeech() {
    for (const group of this.#groups.values()) group.speechEligible = false;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    this.#groups.clear();
    this.#subscribers.length = 0;
  }

  #cancelTimer() {
    if (this.#timer !== undefined) this.#clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerDeadline = undefined;
  }

  subscribe(handler) {
    if (typeof handler !== "function") throw new TypeError("Attention subscriber must be a function");
    if (this.#closed) return () => {};
    this.#subscribers.push(handler);
    return () => {
      const index = this.#subscribers.indexOf(handler);
      if (index >= 0) this.#subscribers.splice(index, 1);
    };
  }

  #recordDecision(decision) {
    this.#decisions.push(decision);
    if (this.#decisions.length > this.#config.decisionHistoryLimit) {
      const dropped = this.#decisions.shift();
      this.#diagnostic({ code: "attention.decision_dropped", droppedDecisionId: dropped.id });
    }
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(decision);
      } catch (error) {
        this.#diagnostic({ code: "attention.subscriber_failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  #failureDecision({ createdAt, classification, primaryEventId, sourceEventIds, group = null }) {
    return assertAttentionDecision({
      id: this.#failureIdFactory(),
      createdAt,
      action: AttentionAction.IGNORE,
      priority: 0,
      reason: "policy_failed",
      classification,
      sourceEventIds: [...sourceEventIds],
      primaryEventId,
      score: {
        total: 0,
        threshold: this.#config.scoring.quietThreshold,
        factors: [],
      },
      group,
      candidate: null,
    });
  }

  getRecentDecisions({ limit = this.#config.decisionHistoryLimit } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Attention decision limit must be a non-negative integer");
    return this.#decisions.slice(-Math.min(limit, this.#config.decisionHistoryLimit)).map((decision) => structuredClone(decision));
  }

  getStatus() {
    const now = Math.max(this.#latestReceivedAt, this.#clock());
    return {
      mode: this.#mode,
      trafficLevel: this.#trafficLevel(now),
      recentChatCount: this.#recent.length,
      pendingGroupCount: this.#groups.size,
      decisionHistorySize: this.#decisions.length,
    };
  }

  #diagnostic(diagnostic) {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Diagnostics cannot interrupt attention processing.
    }
  }
}
