import { assertSpeechEngine, isSpeechCancellation } from "./speech-engine.js";

function errorFields(error) {
  return {
    errorCode: typeof error?.code === "string" ? error.code : undefined,
    error: error instanceof Error ? error.message : String(error),
  };
}

export class SpeechWorker {
  #queue;
  #engine;
  #onDiagnostic;
  #controller;
  #runPromise;
  #started = false;
  #state = "stopped";
  #paused = false;
  #pauseWaiters = [];
  #stateSubscribers = [];
  #currentRequestId = null;
  #utteranceController;

  constructor({ queue, engine, onDiagnostic = () => {} }) {
    if (!queue || typeof queue.take !== "function" || typeof queue.close !== "function") {
      throw new TypeError("SpeechWorker requires a consumable SpeechQueue");
    }
    this.#queue = queue;
    this.#engine = assertSpeechEngine(engine);
    this.#onDiagnostic = onDiagnostic;
  }

  run(signal) {
    if (this.#started) throw new Error("SpeechWorker can only be started once");
    this.#started = true;
    this.#setState("idle");
    this.#controller = new AbortController();
    const onAbort = () => this.#controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) this.#controller.abort();
    this.#runPromise = this.#consume(this.#controller.signal).finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
    return this.#runPromise;
  }

  async drain() {
    if (this.#runPromise && this.#state !== "stopped") this.#setState("draining");
    this.resume();
    this.#queue.close();
    if (this.#runPromise) return this.#runPromise;
    await this.#closeEngine();
    return { status: "drained", completed: 0, failed: 0 };
  }

  async cancel() {
    this.#queue.clear();
    this.#queue.close();
    this.#controller?.abort();
    if (this.#runPromise) return this.#runPromise;
    await this.#closeEngine();
    return { status: "cancelled", completed: 0, failed: 0 };
  }

  close({ drain = true } = {}) {
    return drain ? this.drain() : this.cancel();
  }

  pause() {
    if (!this.#started || this.#state === "stopped" || this.#state === "error") return false;
    if (this.#paused) return false;
    this.#paused = true;
    if (this.#state !== "speaking") this.#setState("paused");
    this.#diagnostic({ code: "speech.paused" });
    return true;
  }

  resume() {
    if (!this.#paused) return false;
    this.#paused = false;
    for (const resolve of this.#pauseWaiters.splice(0)) resolve();
    if (this.#state === "paused") this.#setState("idle");
    this.#diagnostic({ code: "speech.resumed" });
    return true;
  }

  cancelCurrent() {
    if (!this.#utteranceController || this.#utteranceController.signal.aborted) return false;
    const speechRequestId = this.#currentRequestId;
    this.#utteranceController.abort();
    this.#diagnostic({ code: "speech.cancel_current", speechRequestId });
    return true;
  }

  subscribeState(handler) {
    if (typeof handler !== "function") throw new TypeError("Speech state subscriber must be a function");
    this.#stateSubscribers.push(handler);
    handler(this.getStatus());
    return () => {
      const index = this.#stateSubscribers.indexOf(handler);
      if (index >= 0) this.#stateSubscribers.splice(index, 1);
    };
  }

  getStatus() {
    return {
      state: this.#state,
      paused: this.#paused,
      currentRequestId: this.#currentRequestId,
    };
  }

  async #consume(signal) {
    let status = "drained";
    let completed = 0;
    let failed = 0;
    this.#diagnostic({ code: "speech_worker.started" });

    try {
      while (true) {
        await this.#waitUntilResumed(signal);
        let request;
        try {
          request = await this.#queue.take(signal);
        } catch (error) {
          if (isSpeechCancellation(error) || signal.aborted) {
            status = "cancelled";
            break;
          }
          throw error;
        }
        if (request === null) break;

        await this.#waitUntilResumed(signal);

        const identifiers = { speechRequestId: request.id, eventId: request.eventId };
        this.#currentRequestId = request.id;
        this.#utteranceController = new AbortController();
        const onWorkerAbort = () => this.#utteranceController.abort();
        signal.addEventListener("abort", onWorkerAbort, { once: true });
        this.#setState("speaking");
        this.#diagnostic({ code: "speech.started", ...identifiers });
        try {
          await this.#engine.speak(request.text, { signal: this.#utteranceController.signal, request });
          completed += 1;
          this.#diagnostic({ code: "speech.completed", ...identifiers });
        } catch (error) {
          if (signal.aborted) {
            status = "cancelled";
            this.#diagnostic({ code: "speech.cancelled", ...identifiers });
            break;
          }
          if (isSpeechCancellation(error) || this.#utteranceController.signal.aborted) {
            this.#diagnostic({ code: "speech.cancelled", ...identifiers });
            continue;
          }

          failed += 1;
          this.#diagnostic({ code: "speech.failed", ...identifiers, ...errorFields(error) });
          if (typeof error?.code === "string" && error.code.startsWith("speech_engine.")) {
            this.#diagnostic({ code: error.code, ...identifiers, error: error.message });
          }
          if (error?.permanent === true) {
            status = "engine_unavailable";
            this.#queue.clear();
            this.#queue.close();
            break;
          }
        } finally {
          signal.removeEventListener("abort", onWorkerAbort);
          this.#utteranceController = undefined;
          this.#currentRequestId = null;
          if (this.#state !== "draining") this.#setState(this.#paused ? "paused" : "idle");
        }
      }
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed";
      if (!signal.aborted) this.#setState("error");
      this.#diagnostic({ code: "speech_worker.failed", ...errorFields(error) });
    } finally {
      this.#paused = false;
      for (const resolve of this.#pauseWaiters.splice(0)) resolve();
      await this.#closeEngine();
      this.#setState(status === "failed" || status === "engine_unavailable" ? "error" : "stopped");
      this.#diagnostic({ code: "speech_worker.stopped", status, completed, failed });
    }

    return { status, completed, failed };
  }

  #waitUntilResumed(signal) {
    if (!this.#paused) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new DOMException("Speech worker cancelled", "AbortError"));
    this.#setState("paused");
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.#pauseWaiters.indexOf(finish);
        if (index >= 0) this.#pauseWaiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Speech worker cancelled", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pauseWaiters.push(finish);
    });
  }

  #setState(state) {
    if (state === this.#state) return;
    this.#state = state;
    const snapshot = this.getStatus();
    for (const subscriber of [...this.#stateSubscribers]) {
      try {
        subscriber(snapshot);
      } catch {
        // State observers cannot interrupt speech playback.
      }
    }
  }

  async #closeEngine() {
    try {
      await this.#engine.close();
    } catch (error) {
      this.#diagnostic({ code: "speech_engine.close_failed", ...errorFields(error) });
    }
  }

  #diagnostic(diagnostic) {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never interrupt speech sequencing.
    }
  }
}
