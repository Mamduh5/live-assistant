const TEXT_PREVIEW_LIMIT = 180;

function preview(value) {
  if (typeof value !== "string") return null;
  return value.length > TEXT_PREVIEW_LIMIT ? `${value.slice(0, TEXT_PREVIEW_LIMIT - 1)}…` : value;
}

export function projectAttentionDecision(decision, { speech } = {}) {
  return {
    id: decision.id,
    createdAt: decision.createdAt,
    action: decision.action,
    priority: decision.priority,
    reason: decision.reason,
    classification: decision.classification,
    ...(decision.strategy ? { strategy: decision.strategy } : {}),
    ...(Number.isFinite(decision.importance) ? { importance: decision.importance } : {}),
    ...(decision.provider ? { provider: { name: decision.provider.name, model: decision.provider.model } } : {}),
    ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
    sourceEventIds: [...decision.sourceEventIds],
    primaryEventId: decision.primaryEventId,
    score: {
      total: decision.score.total,
      threshold: decision.score.threshold,
      factors: decision.score.factors.map((factor) => ({ code: factor.code, value: factor.value })),
    },
    group: decision.group ? { ...decision.group } : null,
    displayText: preview(decision.candidate?.text ?? decision.summary),
    ...(decision.summary ? { summary: preview(decision.summary) } : {}),
    ...(speech ? { speech: structuredClone(speech) } : {}),
  };
}
