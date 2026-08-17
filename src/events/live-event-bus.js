import { assertLiveEvent } from "./live-event.js";

export class LiveEventBus {
  #queue = [];
  #history = [];
  #subscribers = [];
  #drainPromise = null;
  #maxQueue;
  #historyLimit;
  #onDiagnostic;

  constructor({ maxQueue, historyLimit, onDiagnostic = () => {} }) {
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new RangeError("maxQueue must be a positive integer");
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new RangeError("historyLimit must be a positive integer");
    this.#maxQueue = maxQueue;
    this.#historyLimit = historyLimit;
    this.#onDiagnostic = onDiagnostic;
  }

  subscribe(handler) {
    if (typeof handler !== "function") throw new TypeError("Subscriber must be a function");
    this.#subscribers.push(handler);
    return () => {
      const index = this.#subscribers.indexOf(handler);
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
    if (this.#drainPromise) return;
    this.#drainPromise = Promise.resolve().then(() => this.#drain());
  }

  async #drain() {
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift();
        this.#history.push(event);
        if (this.#history.length > this.#historyLimit) this.#history.shift();

        for (const subscriber of [...this.#subscribers]) {
          try {
            await subscriber(event);
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

  getHistory() {
    return [...this.#history];
  }
}

