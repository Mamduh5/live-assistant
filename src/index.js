export { DEFAULT_CONFIG, loadConfig } from "./config/defaults.js";
export { AVAILABLE_CONNECTORS, cliOption, isAvailableConnector } from "./cli-options.js";
export { AttentionEngine, resolveAttentionMode } from "./attention/attention-engine.js";
export { AiAttentionBatcher } from "./attention/ai-attention-batcher.js";
export { AiProviderError, OpenAiAttentionProvider, aiProviderConfigurationIssue, validateAiAnalysis } from "./attention/ai-attention-provider.js";
export {
  AI_ATTENTION_INSTRUCTIONS,
  AI_ATTENTION_PROMPT_VERSION,
  AI_ATTENTION_RESPONSE_SCHEMA,
  AI_REASON_CODES,
} from "./attention/ai-attention-prompt.js";
export { AttentionAction, AttentionClassification, assertAttentionDecision, assertSpeechCandidate } from "./attention/attention-contracts.js";
export {
  DeterministicAttentionPolicy,
  classifyAttentionEvent,
  formatGroupedQuestion,
  formatQuestionText,
  normalizeExactQuestion,
  speechUserId,
  stableUserKey,
} from "./attention/deterministic-attention-policy.js";
export { LocalControlServer } from "./control/local-control-server.js";
export { SseBroker } from "./control/sse-broker.js";
export {
  RawSimulatorConnector,
  RAW_SIMULATOR_SCENARIOS,
  SimulatorConnector,
  SIMULATOR_SCENARIOS,
} from "./connectors/simulator-connector.js";
export { TikFinityConnector, abortableDelay } from "./connectors/tikfinity-connector.js";
export {
  TikTokBrowserConnector, binaryFrameFromCdp, closeOwnedTarget,
  createOwnedTarget, createSafeBackgroundTarget, navigateOwnedTarget, isTikTokWebcastSocket, normalizeTikTokUsername,
} from "./connectors/tiktok-browser/tiktok-browser-connector.js";
export { classifyTikTokPresentationRequest, installTikTokMediaBlocker, shouldBlockTikTokMedia } from "./connectors/tiktok-browser/media-blocker.js";
export { CdpClient, CdpProtocolError, discoverBrowserWebSocket, sanitizedUrl, validateCdpUrl, waitForWebSocketOpen } from "./connectors/tiktok-browser/cdp-client.js";
export { decodeWebcastFrame, encodeSyntheticWebcastFrame, SUPPORTED_WEBCAST_METHODS } from "./connectors/tiktok-browser/webcast-decoder.js";
export { EventHistory } from "./events/event-history.js";
export { LiveEventBus } from "./events/live-event-bus.js";
export {
  LIVE_EVENT_SCHEMA_VERSION,
  LiveEventType,
  assertLiveEvent,
  createLiveEvent,
  createUnknownEvent,
} from "./events/live-event.js";
export { inspectEvent } from "./inspection/event-inspector.js";
export { projectAttentionDecision } from "./inspection/attention-projection.js";
export { projectEvent, summarizeEvent } from "./inspection/event-projection.js";
export { createJsonLogger } from "./logging/json-logger.js";
export { runConnector } from "./live/run-connector.js";
export { LiveAssistantRuntime, RuntimeControlError } from "./live/live-assistant-runtime.js";
export { normalizeRawSimulatorPayload } from "./normalization/raw-simulator-normalizer.js";
export { normalizeTikFinityEnvelope } from "./normalization/tikfinity-normalizer.js";
export { normalizeTikTokBrowserEvent } from "./normalization/tiktok-browser-normalizer.js";
export { DeterministicSpeechPolicy } from "./speech/deterministic-speech-policy.js";
export { createSpeechEngine, resolveSpeechEngineType } from "./speech/create-speech-engine.js";
export { SpeechEngineError, assertSpeechEngine, isSpeechCancellation } from "./speech/speech-engine.js";
export { SpeechQueue } from "./speech/speech-queue.js";
export { SpeechWorker } from "./speech/speech-worker.js";
export { mapWindowsModernRate, mapWindowsModernVolume, WINDOWS_SPEECH_SCRIPT, WindowsSystemSpeechEngine } from "./speech/windows-system-speech-engine.js";
export {
  discoverWindowsModernSpeechVoices, discoverWindowsSystemSpeechVoices, sanitizeWindowsVoiceInventory,
  WINDOWS_MODERN_VOICE_DISCOVERY_SCRIPT, WINDOWS_VOICE_DISCOVERY_SCRIPT,
} from "./speech/windows-voice-discovery.js";
export { detectSpeechScript, selectWindowsSpeechVoice } from "./speech/windows-voice-selection.js";
