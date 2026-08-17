import { LiveEventType, assertLiveEvent } from "./live-event.js";

const EVENT_TYPES = new Set(Object.values(LiveEventType));

export class LiveEventBus {
  #queue = [];
  #subscribers = [];
  #drainPromise = null;
  #maxQueue;
  #onDiagnostic;

  constructor({ maxQueue, onDiagnostic = () => {} }) {
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new RangeError("maxQueue must be a positive integer");
    this.#maxQueue = maxQueue;
    this.#onDiagnostic = onDiagnostic;
  }

  subscribe(typeOrHandler, possibleHandler) {
    const type = typeof typeOrHandler === "string" ? typeOrHandler : null;
    const handler = type === null ? typeOrHandler : possibleHandler;
    if (type !== null && !EVENT_TYPES.has(type)) throw new TypeError(`Unsupported subscription type: ${type}`);
    if (typeof handler !== "function") throw new TypeError("Subscriber must be a function");

    const subscription = { type, handler };
    this.#subscribers.push(subscription);
    return () => {
      const index = this.#subscribers.indexOf(subscription);
      if (index >= 0) this.#subscribers.splice(index, 1);
    };
  }

  publish(event) {
    assertLiveEvent(event);
    let dropped = null;

    if (this.#queue.length >= this.#maxQueue) {
      dropped = this.#queue.shift();
      this.#onDiagnostic({
        code: "event_bus.queue_overflow",
        policy: "drop_oldest",
        droppedEventId: dropped.id,
        maxQueue: this.#maxQueue,
      });
    }

    this.#queue.push(event);
    this.#scheduleDrain();
    return { accepted: true, droppedEventId: dropped?.id ?? null };
  }

  #scheduleDrain() {
    if (!this.#drainPromise) this.#drainPromise = Promise.resolve().then(() => this.#drain());
  }

  async #drain() {
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift();
        for (const { type, handler } of [...this.#subscribers]) {
          if (type !== null && type !== event.type) continue;
          try {
            await handler(event);
          } catch (error) {
            this.#onDiagnostic({
              code: "event_bus.subscriber_failed",
              eventId: event.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } finally {
      this.#drainPromise = null;
      if (this.#queue.length > 0) this.#scheduleDrain();
    }
  }

  async flush() {
    while (this.#drainPromise) await this.#drainPromise;
  }
}

