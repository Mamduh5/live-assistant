import { randomUUID } from "node:crypto";
import { LiveEventType } from "../events/live-event.js";
import { assertSpeechCandidate } from "../attention/attention-contracts.js";

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

function normalizedMessage(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export class DeterministicSpeechPolicy {
  #config;
  #enabledEventTypes;
  #disabledUserIds;
  #recentMessages = new Map();
  #recentUsers = new Map();
  #idFactory;

  constructor(config, { idFactory = randomUUID } = {}) {
    this.#config = config;
    this.#enabledEventTypes = new Set(config.enabledEventTypes);
    this.#disabledUserIds = new Set(config.disabledUserIds);
    this.#idFactory = idFactory;
  }

  evaluate(event, { now = event.receivedAt, queuePressure = 0 } = {}) {
    if (!this.#enabledEventTypes.has(event.type) || event.type !== LiveEventType.CHAT_MESSAGE) {
      return this.#ignore("disabled_event_type");
    }
    return this.evaluateCandidate({
      text: event.data.text,
      priority: 50,
      primaryEventId: event.id,
      sourceEventIds: [event.id],
      ...(event.user?.id ? { userId: event.user.id } : {}),
      createdAt: now,
      speechEligible: true,
    }, { now, queuePressure });
  }

  evaluateCandidate(candidate, { now = candidate.createdAt, queuePressure = 0 } = {}) {
    assertSpeechCandidate(candidate);
    if (candidate.userId && this.#disabledUserIds.has(candidate.userId)) return this.#ignore("disabled_user");

    const text = candidate.text.trim().replace(/\s+/g, " ");
    if (text.length === 0) return this.#ignore("empty_chat");
    if (!this.#config.allowUrls && URL_PATTERN.test(text)) return this.#ignore("url_not_allowed");
    if (text.length > this.#config.maxMessageLength) return this.#ignore("message_too_long");
    if (queuePressure >= this.#config.queuePressureThreshold) return this.#ignore("queue_pressure");

    this.#removeExpired(now);
    const normalized = normalizedMessage(text);
    const previousMessage = this.#recentMessages.get(normalized);
    if (previousMessage !== undefined && now - previousMessage <= this.#config.duplicateWindowMs) {
      return this.#ignore("duplicate_chat");
    }

    const userId = candidate.userId;
    const previousUser = userId ? this.#recentUsers.get(userId) : undefined;
    if (previousUser !== undefined && now - previousUser <= this.#config.perUserCooldownMs) {
      return this.#ignore("user_cooldown");
    }

    this.#setBounded(this.#recentMessages, normalized, now, this.#config.maxTrackedMessages);
    if (userId) this.#setBounded(this.#recentUsers, userId, now, this.#config.maxTrackedUsers);

    const priority = candidate.priority;
    return {
      action: "queue_speech",
      priority,
      reason: "chat_allowed",
      request: {
        id: this.#idFactory(),
        eventId: candidate.primaryEventId,
        ...(candidate.sourceEventIds.length > 1 ? { sourceEventIds: [...candidate.sourceEventIds] } : {}),
        text,
        priority,
        createdAt: now,
      },
    };
  }

  #ignore(reason) {
    return { action: "ignore", priority: 0, reason };
  }

  #removeExpired(now) {
    for (const [message, timestamp] of this.#recentMessages) {
      if (now - timestamp > this.#config.duplicateWindowMs) this.#recentMessages.delete(message);
    }
    for (const [userId, timestamp] of this.#recentUsers) {
      if (now - timestamp > this.#config.perUserCooldownMs) this.#recentUsers.delete(userId);
    }
  }

  #setBounded(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  get trackedMessageCount() {
    return this.#recentMessages.size;
  }
}
