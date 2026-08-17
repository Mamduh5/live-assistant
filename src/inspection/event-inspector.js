export function inspectEvent(event, decision, { includeRaw = false, actionResult } = {}) {
  return {
    eventId: event.id,
    type: event.type,
    platform: event.platform,
    connector: event.connector,
    eventTimestamp: event.timestamp,
    receivedAt: event.receivedAt,
    user: event.user ?? null,
    data: event.data,
    decision,
    ...(actionResult ? { actionResult } : {}),
    ...(includeRaw ? { raw: event.raw } : {}),
  };
}
