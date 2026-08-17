export class SpeechEngineError extends Error {
  constructor(message, { code = "speech_engine.failed", permanent = false, cause } = {}) {
    super(message, { cause });
    this.name = "SpeechEngineError";
    this.code = code;
    this.permanent = permanent;
  }
}

export function assertSpeechEngine(engine) {
  if (!engine || typeof engine.speak !== "function" || typeof engine.close !== "function") {
    throw new TypeError("SpeechEngine must provide speak(text, options) and close()");
  }
  return engine;
}

export function isSpeechCancellation(error) {
  return error?.name === "AbortError" || error?.code === "speech.cancelled";
}

