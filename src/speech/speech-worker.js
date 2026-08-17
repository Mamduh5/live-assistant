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

  async #consume(signal) {
    let status = "drained";
    let completed = 0;
    let failed = 0;
    this.#diagnostic({ code: "speech_worker.started" });

    try {
      while (true) {
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

        const identifiers = { speechRequestId: request.id, eventId: request.eventId };
        this.#diagnostic({ code: "speech.started", ...identifiers });
        try {
          await this.#engine.speak(request.text, { signal, request });
          completed += 1;
          this.#diagnostic({ code: "speech.completed", ...identifiers });
        } catch (error) {
          if (isSpeechCancellation(error) || signal.aborted) {
            status = "cancelled";
            this.#diagnostic({ code: "speech.cancelled", ...identifiers });
            break;
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
        }
      }
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed";
      this.#diagnostic({ code: "speech_worker.failed", ...errorFields(error) });
    } finally {
      await this.#closeEngine();
      this.#diagnostic({ code: "speech_worker.stopped", status, completed, failed });
    }

    return { status, completed, failed };
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
