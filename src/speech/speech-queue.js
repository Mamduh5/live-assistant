function assertSpeechRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("SpeechRequest must be an object");
  if (typeof request.id !== "string" || typeof request.eventId !== "string") throw new TypeError("SpeechRequest IDs are required");
  if (typeof request.text !== "string" || request.text.length === 0) throw new TypeError("SpeechRequest.text is required");
  if (!Number.isFinite(request.priority) || !Number.isFinite(request.createdAt)) throw new TypeError("SpeechRequest priority and createdAt are required");
  return request;
}

function abortError() {
  return new DOMException("Speech queue wait was cancelled", "AbortError");
}

export class SpeechQueue {
  #queue = [];
  #waiters = [];
  #closed = false;
  #maxQueue;
  #onDiagnostic;

  constructor({ maxQueue, onDiagnostic = () => {} }) {
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new RangeError("Speech queue limit must be a positive integer");
    this.#maxQueue = maxQueue;
    this.#onDiagnostic = onDiagnostic;
  }

  enqueue(request) {
    assertSpeechRequest(request);
    if (this.#closed) {
      this.#onDiagnostic({ code: "speech_queue.closed", requestId: request.id });
      return { accepted: false, reason: "queue_closed" };
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.cleanup();
      waiter.resolve(request);
      return { accepted: true, position: 0 };
    }

    if (this.#queue.length >= this.#maxQueue) {
      this.#onDiagnostic({ code: "speech_queue.full", requestId: request.id, maxQueue: this.#maxQueue });
      return { accepted: false, reason: "queue_full" };
    }
    this.#queue.push(request);
    return { accepted: true, position: this.#queue.length - 1 };
  }

  dequeue() {
    return this.#queue.shift() ?? null;
  }

  take(signal) {
    const request = this.dequeue();
    if (request) return Promise.resolve(request);
    if (this.#closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter.cleanup();
        reject(abortError());
      };
      const waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.cleanup();
      waiter.resolve(null);
    }
  }

  clear() {
    const removed = this.#queue.length;
    this.#queue.length = 0;
    return removed;
  }

  get size() {
    return this.#queue.length;
  }

  get pressure() {
    return this.#queue.length / this.#maxQueue;
  }

  get closed() {
    return this.#closed;
  }

  get waitingConsumerCount() {
    return this.#waiters.length;
  }
}
