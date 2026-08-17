export const AttentionAction = Object.freeze({
  IGNORE: "ignore",
  PROMOTE: "promote",
});

export const AttentionClassification = Object.freeze({
  QUESTION: "question",
  MESSAGE: "message",
  LOW_INFORMATION: "low_information",
  NON_CHAT: "non_chat",
});

const ACTIONS = new Set(Object.values(AttentionAction));
const CLASSIFICATIONS = new Set(Object.values(AttentionClassification));

export function assertSpeechCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("SpeechCandidate must be an object");
  if (typeof candidate.text !== "string") throw new TypeError("SpeechCandidate.text must be a string");
  if (!Number.isFinite(candidate.priority) || candidate.priority < 0 || candidate.priority > 100) throw new TypeError("SpeechCandidate.priority must be between 0 and 100");
  if (typeof candidate.primaryEventId !== "string" || candidate.primaryEventId.length === 0) throw new TypeError("SpeechCandidate.primaryEventId is required");
  if (!Array.isArray(candidate.sourceEventIds) || candidate.sourceEventIds.length < 1 || candidate.sourceEventIds.some((id) => typeof id !== "string")) {
    throw new TypeError("SpeechCandidate.sourceEventIds must contain event IDs");
  }
  if (!Number.isFinite(candidate.createdAt)) throw new TypeError("SpeechCandidate.createdAt is required");
  if (candidate.userId !== undefined && typeof candidate.userId !== "string") throw new TypeError("SpeechCandidate.userId must be a string");
  if (typeof candidate.speechEligible !== "boolean") throw new TypeError("SpeechCandidate.speechEligible must be boolean");
  return candidate;
}

export function assertAttentionDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw new TypeError("AttentionDecision must be an object");
  if (typeof decision.id !== "string" || decision.id.length === 0) throw new TypeError("AttentionDecision.id is required");
  if (!Number.isFinite(decision.createdAt)) throw new TypeError("AttentionDecision.createdAt is required");
  if (!ACTIONS.has(decision.action)) throw new TypeError("AttentionDecision.action is invalid");
  if (!CLASSIFICATIONS.has(decision.classification)) throw new TypeError("AttentionDecision.classification is invalid");
  if (!Number.isFinite(decision.priority) || decision.priority < 0 || decision.priority > 100) throw new TypeError("AttentionDecision.priority must be between 0 and 100");
  if (typeof decision.reason !== "string" || decision.reason.length === 0) throw new TypeError("AttentionDecision.reason is required");
  if (!Array.isArray(decision.sourceEventIds) || decision.sourceEventIds.length < 1) throw new TypeError("AttentionDecision.sourceEventIds are required");
  if (typeof decision.primaryEventId !== "string") throw new TypeError("AttentionDecision.primaryEventId is required");
  if (!decision.score || !Number.isFinite(decision.score.total) || !Number.isFinite(decision.score.threshold) || !Array.isArray(decision.score.factors)) {
    throw new TypeError("AttentionDecision.score is invalid");
  }
  if (decision.candidate !== null && decision.candidate !== undefined) assertSpeechCandidate(decision.candidate);
  return decision;
}
