import { randomUUID } from "node:crypto";
import { assertLiveEvent, createUnknownEvent } from "../events/live-event.js";

export async function runConnector({ connector, normalize, bus, signal, logger, clock = Date.now, idFactory = randomUUID }) {
  logger.info("connector.started", { connector: connector.name });
  let received = 0;

  try {
    for await (const raw of connector.events(signal)) {
      if (signal?.aborted) break;
      let event;
      try {
        event = normalize ? normalize(raw) : assertLiveEvent(raw);
      } catch (error) {
        const receivedAt = clock();
        event = createUnknownEvent({
          id: idFactory(),
          connector: connector.name,
          timestamp: receivedAt,
          receivedAt,
          raw,
          reason: "normalizer_failed",
        });
        logger.warn("normalizer.failed", {
          connector: connector.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      bus.publish(event);
      received += 1;
    }
    await bus.flush();
    const status = signal?.aborted ? "cancelled" : "completed";
    logger.info("connector.stopped", { connector: connector.name, status, received });
    return { status, received };
  } catch (error) {
    await bus.flush();
    logger.error("connector.failed", {
      connector: connector.name,
      received,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", received, error };
  }
}
