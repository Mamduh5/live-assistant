export function inspectEvent(event, decision, { includeRaw = false } = {}) {
  return {
    eventId: event.id,
    type: event.type,
    platform: event.platform,
    occurredAt: event.occurredAt,
    actor: event.actor,
    data: event.data,
    decision,
    source: event.source,
    ...(includeRaw ? { raw: event.raw } : {}),
  };
}

