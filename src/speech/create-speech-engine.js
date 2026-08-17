import { WindowsSystemSpeechEngine } from "./windows-system-speech-engine.js";

const SPEECH_ENGINE_TYPES = new Set(["off", "windows"]);

export function resolveSpeechEngineType(requestedType, configuredType = "off") {
  const type = requestedType ?? configuredType;
  if (!SPEECH_ENGINE_TYPES.has(type)) throw new RangeError(`Unsupported speech engine: ${type}`);
  return type;
}

export function createSpeechEngine({ type, config, windowsDependencies = {} }) {
  const resolvedType = resolveSpeechEngineType(type, config.type);
  if (resolvedType === "off") return null;
  return new WindowsSystemSpeechEngine({ ...config.windows, ...windowsDependencies });
}
