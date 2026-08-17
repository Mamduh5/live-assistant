import { assertLiveEvent } from "./live-event.js";

export class EventHistory {
  #events = [];
  #limit;

  constructor({ limit }) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Event history limit must be a positive integer");
    this.#limit = limit;
  }

  record(event) {
    assertLiveEvent(event);
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.shift();
  }

  getEvents({ type, limit = this.#limit } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("History query limit must be a non-negative integer");
    const matching = type ? this.#events.filter((event) => event.type === type) : this.#events;
    return matching.slice(-limit);
  }

  get size() {
    return this.#events.length;
  }
}

