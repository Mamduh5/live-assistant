import { randomUUID } from "node:crypto";
import { LiveEventType } from "../events/live-event.js";
import {
  AttentionAction,
  AttentionClassification,
  assertAttentionDecision,
  assertSpeechCandidate,
} from "./attention-contracts.js";

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const TERMINAL_QUESTION = /[?؟]+$/u;

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

export function normalizeExactQuestion(text) {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(TERMINAL_QUESTION, "?")
    .toLocaleLowerCase("und");
}

export function formatQuestionText(text) {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(TERMINAL_QUESTION, "?");
}

export function classifyAttentionEvent(event) {
  if (event.type !== LiveEventType.CHAT_MESSAGE) return AttentionClassification.NON_CHAT;
  const text = event.data.text.normalize("NFKC").trim();
  if (!LETTER_OR_NUMBER.test(text)) return AttentionClassification.LOW_INFORMATION;
  if (TERMINAL_QUESTION.test(text)) return AttentionClassification.QUESTION;
  return AttentionClassification.MESSAGE;
}

export function stableUserKey(user) {
  if (typeof user?.id === "string" && user.id.length > 0) return `id:${user.id}`;
  if (typeof user?.username === "string" && user.username.length > 0) return `username:${user.username}`;
  return null;
}

export function speechUserId(user) {
  if (typeof user?.id === "string" && user.id.length > 0) return user.id;
  if (typeof user?.username === "string" && user.username.length > 0) return `username:${user.username}`;
  return undefined;
}

export function formatGroupedQuestion(group) {
  return group.uniqueUsers > 1
    ? `${group.uniqueUsers} viewers asked: ${group.representativeText}`
    : group.representativeText;
}

export class DeterministicAttentionPolicy {
  #config;
  #idFactory;

  constructor(config, { idFactory = randomUUID } = {}) {
    this.#config = config;
    this.#idFactory = idFactory;
  }

  classify(event) {
    return classifyAttentionEvent(event);
  }

  decide({
    mode,
    classification,
    representativeText,
    sourceEventIds,
    primaryEventId,
    userId,
    group,
    trafficLevel,
    createdAt,
    speechEligible,
  }) {
    const threshold = this.#threshold(trafficLevel);
    const base = this.#base(classification);
    const factors = mode === "passthrough"
      ? [{ code: "passthrough_priority", value: 50 }]
      : [{ code: `${classification}_base`, value: base }];
    let repeatBonus = 0;
    if (classification === AttentionClassification.QUESTION && group) {
      repeatBonus = Math.min(
        this.#config.scoring.repeatedQuestionBonusCap,
        Math.max(0, group.uniqueUsers - 1) * this.#config.scoring.repeatedQuestionBonusPerUser,
      );
      if (repeatBonus > 0 && mode !== "passthrough") factors.push({ code: "repeat_viewers", value: repeatBonus });
    }
    const total = clampScore(mode === "passthrough" ? 50 : base + repeatBonus);

    let action = AttentionAction.IGNORE;
    let reason;
    if (classification === AttentionClassification.NON_CHAT) {
      reason = "non_chat";
    } else if (mode === "passthrough") {
      action = AttentionAction.PROMOTE;
      reason = "passthrough";
    } else if (classification === AttentionClassification.LOW_INFORMATION) {
      reason = "low_information";
    } else if (total < threshold) {
      reason = "below_attention_threshold";
    } else {
      action = AttentionAction.PROMOTE;
      reason = classification === AttentionClassification.QUESTION
        ? (group?.occurrences > 1 ? "repeated_question" : "question_allowed")
        : "message_allowed";
    }

    const candidate = action === AttentionAction.PROMOTE
      ? assertSpeechCandidate({
        text: classification === AttentionClassification.QUESTION && group
          ? formatGroupedQuestion(group)
          : representativeText,
        priority: total,
        primaryEventId,
        sourceEventIds: [...sourceEventIds],
        ...(userId ? { userId } : {}),
        createdAt,
        speechEligible,
      })
      : null;

    return assertAttentionDecision({
      id: this.#idFactory(),
      createdAt,
      action,
      priority: total,
      reason,
      classification,
      strategy: mode === "passthrough" ? "passthrough" : "deterministic",
      sourceEventIds: [...sourceEventIds],
      primaryEventId,
      score: { total, threshold, factors },
      group: group ? {
        kind: "exact",
        key: group.key,
        occurrences: group.occurrences,
        uniqueUsers: group.uniqueUsers,
        firstSeen: group.firstSeen,
        deadline: group.deadline,
      } : null,
      candidate,
    });
  }

  failureDecision(event, { createdAt = event.receivedAt } = {}) {
    return assertAttentionDecision({
      id: this.#idFactory(),
      createdAt,
      action: AttentionAction.IGNORE,
      priority: 0,
      reason: "policy_failed",
      classification: event.type === LiveEventType.CHAT_MESSAGE
        ? AttentionClassification.MESSAGE
        : AttentionClassification.NON_CHAT,
      strategy: "deterministic",
      sourceEventIds: [event.id],
      primaryEventId: event.id,
      score: { total: 0, threshold: this.#config.scoring.quietThreshold, factors: [] },
      group: null,
      candidate: null,
    });
  }

  #base(classification) {
    switch (classification) {
      case AttentionClassification.QUESTION: return this.#config.scoring.questionBase;
      case AttentionClassification.MESSAGE: return this.#config.scoring.messageBase;
      case AttentionClassification.LOW_INFORMATION: return this.#config.scoring.lowInformationBase;
      default: return 0;
    }
  }

  #threshold(trafficLevel) {
    if (trafficLevel === "very_busy") return this.#config.scoring.veryBusyThreshold;
    if (trafficLevel === "busy") return this.#config.scoring.busyThreshold;
    return this.#config.scoring.quietThreshold;
  }
}
