function assertSpeechRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("SpeechRequest must be an object");
  if (typeof request.id !== "string" || typeof request.eventId !== "string") throw new TypeError("SpeechRequest IDs are required");
  if (typeof request.text !== "string" || request.text.length === 0) throw new TypeError("SpeechRequest.text is required");
  if (!Number.isFinite(request.priority) || !Number.isFinite(request.createdAt)) throw new TypeError("SpeechRequest priority and createdAt are required");
  return request;
}

export class SpeechQueue {
  #queue = [];
  #maxQueue;
  #onDiagnostic;

  constructor({ maxQueue, onDiagnostic = () => {} }) {
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new RangeError("Speech queue limit must be a positive integer");
    this.#maxQueue = maxQueue;
    this.#onDiagnostic = onDiagnostic;
  }

  enqueue(request) {
    assertSpeechRequest(request);
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

  get size() {
    return this.#queue.length;
  }

  get pressure() {
    return this.#queue.length / this.#maxQueue;
  }
}
