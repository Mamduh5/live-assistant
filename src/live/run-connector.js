import { randomUUID } from "node:crypto";
import { createUnknownEvent } from "../events/live-event.js";

export async function runConnector({ connector, normalize, bus, signal, logger, clock = () => new Date(), idFactory = randomUUID }) {
  logger.info("connector.started", { connector: connector.name });
  let received = 0;

  try {
    for await (const raw of connector.events(signal)) {
      if (signal?.aborted) break;
      let event;
      try {
        event = normalize(raw);
      } catch (error) {
        const timestamp = clock().toISOString();
        event = createUnknownEvent({
          id: idFactory(),
          connector: connector.name,
          occurredAt: timestamp,
          receivedAt: timestamp,
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
