import { LiveEventType } from "../events/live-event.js";

function normalizedMessage(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export class DeterministicEventFilter {
  #duplicateWindowMs;
  #maxTrackedMessages;
  #suppressEmptyChat;
  #recentMessages = new Map();

  constructor({ duplicateWindowMs, maxTrackedMessages, suppressEmptyChat }) {
    this.#duplicateWindowMs = duplicateWindowMs;
    this.#maxTrackedMessages = maxTrackedMessages;
    this.#suppressEmptyChat = suppressEmptyChat;
  }

  evaluate(event, now = Date.parse(event.receivedAt)) {
    if (event.type !== LiveEventType.CHAT_MESSAGE) {
      return { action: "emit", reason: "event_type_allowed" };
    }

    const message = normalizedMessage(event.data.text);
    if (this.#suppressEmptyChat && message.length === 0) {
      return { action: "suppress", reason: "empty_chat" };
    }

    this.#removeExpired(now);
    const previous = this.#recentMessages.get(message);
    this.#recentMessages.delete(message);
    this.#recentMessages.set(message, now);
    this.#enforceBound();

    if (previous !== undefined && now - previous <= this.#duplicateWindowMs) {
      return { action: "suppress", reason: "duplicate_chat" };
    }
    return { action: "emit", reason: "chat_allowed" };
  }

  #removeExpired(now) {
    for (const [message, timestamp] of this.#recentMessages) {
      if (now - timestamp > this.#duplicateWindowMs) this.#recentMessages.delete(message);
    }
  }

  #enforceBound() {
    while (this.#recentMessages.size > this.#maxTrackedMessages) {
      this.#recentMessages.delete(this.#recentMessages.keys().next().value);
    }
  }

  get trackedMessageCount() {
    return this.#recentMessages.size;
  }
}

