import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/index.js";

test("loads valid bounded configuration overrides", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_EVENT_QUEUE_LIMIT: "12",
    LIVE_ASSISTANT_HISTORY_LIMIT: "42",
    LIVE_ASSISTANT_SPEECH_QUEUE_LIMIT: "8",
  });
  assert.equal(config.eventBus.maxQueue, 12);
  assert.equal(config.eventHistory.limit, 42);
  assert.equal(config.speechQueue.maxQueue, 8);
});

test("reports invalid configuration and uses a safe default", () => {
  const diagnostics = [];
  const config = loadConfig(
    { LIVE_ASSISTANT_EVENT_QUEUE_LIMIT: "unbounded" },
    (diagnostic) => diagnostics.push(diagnostic),
  );
  assert.equal(config.eventBus.maxQueue, DEFAULT_CONFIG.eventBus.maxQueue);
  assert.equal(diagnostics[0].code, "config.invalid");
});

test("enables explicit raw payload inspection", () => {
  const config = loadConfig({ LIVE_ASSISTANT_INSPECT_RAW: "true" });
  assert.equal(config.inspector.includeRaw, true);
});

test("loads validated TikFinity endpoint and reconnect overrides", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_TIKFINITY_URL: "ws://127.0.0.1:3000/events",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS: "25",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS: "500",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MULTIPLIER: "1.5",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO: "0.1",
  });
  assert.equal(config.tikfinity.url, "ws://127.0.0.1:3000/events");
  assert.deepEqual(config.tikfinity.reconnect, {
    initialDelayMs: 25,
    maxDelayMs: 500,
    multiplier: 1.5,
    jitterRatio: 0.1,
  });
});

test("loads TikTok browser defaults and validated environment overrides", () => {
  assert.deepEqual(loadConfig({}).tiktokBrowser, DEFAULT_CONFIG.tiktokBrowser);
  const config = loadConfig({
    LIVE_ASSISTANT_TIKTOK_BROWSER_USERNAME: '@synthetic_user',
    LIVE_ASSISTANT_TIKTOK_BROWSER_CDP_URL: 'http://localhost:9333',
    LIVE_ASSISTANT_TIKTOK_BROWSER_NAVIGATION_TIMEOUT_MS: '1200',
    LIVE_ASSISTANT_TIKTOK_BROWSER_SOCKET_TIMEOUT_MS: '1300',
    LIVE_ASSISTANT_TIKTOK_BROWSER_STALE_SOCKET_TIMEOUT_MS: '1400',
    LIVE_ASSISTANT_TIKTOK_BROWSER_MAX_QUEUED_EVENTS: '12',
    LIVE_ASSISTANT_TIKTOK_BROWSER_BLOCK_MEDIA: 'false',
    LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_INITIAL_MS: '10',
    LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_MAX_MS: '50',
    LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_MULTIPLIER: '1.5',
    LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_JITTER_RATIO: '0.1',
  });
  assert.equal(config.tiktokBrowser.username, 'synthetic_user'); assert.equal(config.tiktokBrowser.cdpUrl, 'http://localhost:9333');
  assert.equal(config.tiktokBrowser.blockMedia, false); assert.equal(config.tiktokBrowser.staleSocketTimeoutMs, 1400);
  assert.equal(config.tiktokBrowser.maxQueuedEvents, 12);
  assert.deepEqual(config.tiktokBrowser.reconnect, { initialDelayMs: 10, maxDelayMs: 50, multiplier: 1.5, jitterRatio: 0.1 });
});

test("invalid TikTok browser values diagnose and retain safe loopback defaults", () => {
  const diagnostics = [];
  const config = loadConfig({ LIVE_ASSISTANT_TIKTOK_BROWSER_CDP_URL: 'http://192.168.1.5:9222', LIVE_ASSISTANT_TIKTOK_BROWSER_USERNAME: 'bad/name', LIVE_ASSISTANT_TIKTOK_BROWSER_BLOCK_MEDIA: 'yes', LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_INITIAL_MS: '100', LIVE_ASSISTANT_TIKTOK_BROWSER_RECONNECT_MAX_MS: '10' }, (value) => diagnostics.push(value));
  assert.deepEqual(config.tiktokBrowser, DEFAULT_CONFIG.tiktokBrowser); assert.equal(diagnostics.length, 4);
});

test("falls back safely for invalid TikFinity configuration", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_TIKFINITY_URL: "https://public.example.invalid",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_INITIAL_MS: "20000",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_MAX_MS: "100",
    LIVE_ASSISTANT_TIKFINITY_RECONNECT_JITTER_RATIO: "2",
  }, (value) => diagnostics.push(value));
  assert.deepEqual(config.tikfinity, DEFAULT_CONFIG.tikfinity);
  assert.equal(diagnostics.length, 3);
});

test("loads validated Windows speech engine settings", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_SPEECH_ENGINE: "windows",
    LIVE_ASSISTANT_SPEECH_VOICE: "Synthetic Voice",
    LIVE_ASSISTANT_SPEECH_VOICE_EN: "English Voice",
    LIVE_ASSISTANT_SPEECH_VOICE_TH: "Thai Voice",
    LIVE_ASSISTANT_SPEECH_RATE: "-4",
    LIVE_ASSISTANT_SPEECH_VOLUME: "75",
  });
  assert.deepEqual(config.speechEngine, {
    type: "windows",
    windows: {
      executable: "powershell.exe",
      voice: "Synthetic Voice",
      languageVoices: { en: "English Voice", th: "Thai Voice" },
      rate: -4,
      volume: 75,
    },
  });
});

test("invalid speech settings fall back with configuration diagnostics", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_SPEECH_ENGINE: "cloud",
    LIVE_ASSISTANT_SPEECH_VOICE: "",
    LIVE_ASSISTANT_SPEECH_RATE: "11",
    LIVE_ASSISTANT_SPEECH_VOLUME: "101",
  }, (value) => diagnostics.push(value));
  assert.deepEqual(config.speechEngine, DEFAULT_CONFIG.speechEngine);
  assert.equal(diagnostics.length, 4);
});

test("empty numeric speech settings do not become zero implicitly", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_SPEECH_RATE: "",
    LIVE_ASSISTANT_SPEECH_VOLUME: "",
  }, (value) => diagnostics.push(value));
  assert.equal(config.speechEngine.windows.rate, 0);
  assert.equal(config.speechEngine.windows.volume, 100);
  assert.deepEqual(config.speechEngine.windows.languageVoices, { en: null, th: null });
  assert.equal(diagnostics.length, 2);
});

test("loads loopback control server configuration", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_CONTROL_HOST: "localhost",
    LIVE_ASSISTANT_CONTROL_PORT: "4912",
  });
  assert.equal(config.controlServer.host, "localhost");
  assert.equal(config.controlServer.port, 4912);
});

test("rejects non-loopback control hosts and invalid ports", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_CONTROL_HOST: "0.0.0.0",
    LIVE_ASSISTANT_CONTROL_PORT: "70000",
  }, (value) => diagnostics.push(value));
  assert.deepEqual(config.controlServer, DEFAULT_CONFIG.controlServer);
  assert.equal(diagnostics.length, 2);
});

test("loads validated deterministic attention configuration", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_ATTENTION_MODE: "deterministic",
    LIVE_ASSISTANT_ATTENTION_RECENT_WINDOW_MS: "20000",
    LIVE_ASSISTANT_ATTENTION_GROUP_WINDOW_MS: "900",
    LIVE_ASSISTANT_ATTENTION_MAX_RECENT_MESSAGES: "100",
    LIVE_ASSISTANT_ATTENTION_MAX_PENDING_GROUPS: "20",
    LIVE_ASSISTANT_ATTENTION_DECISION_HISTORY_LIMIT: "50",
    LIVE_ASSISTANT_ATTENTION_BUSY_MESSAGE_COUNT: "5",
    LIVE_ASSISTANT_ATTENTION_VERY_BUSY_MESSAGE_COUNT: "10",
    LIVE_ASSISTANT_ATTENTION_QUIET_THRESHOLD: "30",
    LIVE_ASSISTANT_ATTENTION_BUSY_THRESHOLD: "55",
    LIVE_ASSISTANT_ATTENTION_VERY_BUSY_THRESHOLD: "80",
  });
  assert.equal(config.attention.mode, "deterministic");
  assert.equal(config.attention.recentWindowMs, 20_000);
  assert.equal(config.attention.groupWindowMs, 900);
  assert.equal(config.attention.maxRecentMessages, 100);
  assert.equal(config.attention.maxPendingGroups, 20);
  assert.equal(config.attention.decisionHistoryLimit, 50);
  assert.deepEqual(
    [config.attention.scoring.busyMessageCount, config.attention.scoring.veryBusyMessageCount],
    [5, 10],
  );
  assert.deepEqual(
    [config.attention.scoring.quietThreshold, config.attention.scoring.busyThreshold, config.attention.scoring.veryBusyThreshold],
    [30, 55, 80],
  );
});

test("invalid attention mode and relationships fall back safely with diagnostics", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_ATTENTION_MODE: "semantic",
    LIVE_ASSISTANT_ATTENTION_BUSY_MESSAGE_COUNT: "20",
    LIVE_ASSISTANT_ATTENTION_VERY_BUSY_MESSAGE_COUNT: "10",
    LIVE_ASSISTANT_ATTENTION_QUIET_THRESHOLD: "80",
    LIVE_ASSISTANT_ATTENTION_BUSY_THRESHOLD: "50",
  }, (value) => diagnostics.push(value));
  assert.equal(config.attention.mode, "passthrough");
  assert.equal(config.attention.scoring.busyMessageCount, DEFAULT_CONFIG.attention.scoring.busyMessageCount);
  assert.equal(config.attention.scoring.veryBusyMessageCount, DEFAULT_CONFIG.attention.scoring.veryBusyMessageCount);
  assert.equal(config.attention.scoring.quietThreshold, DEFAULT_CONFIG.attention.scoring.quietThreshold);
  assert.equal(config.attention.scoring.busyThreshold, DEFAULT_CONFIG.attention.scoring.busyThreshold);
  assert.equal(diagnostics.length, 3);
});

test("loads validated AI attention and OpenAI tuning without storing a secret", () => {
  const config = loadConfig({
    LIVE_ASSISTANT_ATTENTION_MODE: "ai",
    LIVE_ASSISTANT_AI_PROVIDER: "openai",
    LIVE_ASSISTANT_AI_BATCH_WINDOW_MS: "750",
    LIVE_ASSISTANT_AI_MAX_BATCH_MESSAGES: "12",
    LIVE_ASSISTANT_AI_MAX_BATCH_CHARS: "3000",
    LIVE_ASSISTANT_AI_REQUESTS_PER_MINUTE: "15",
    LIVE_ASSISTANT_AI_REQUEST_TIMEOUT_MS: "4000",
    LIVE_ASSISTANT_OPENAI_MODEL: "gpt-5.6-luna-test",
    LIVE_ASSISTANT_OPENAI_REASONING_EFFORT: "medium",
    LIVE_ASSISTANT_OPENAI_BASE_URL: "http://127.0.0.1:9000/v1",
    OPENAI_API_KEY: "must-not-enter-config",
  });
  assert.equal(config.attention.mode, "ai");
  assert.equal(config.attention.ai.batchWindowMs, 750);
  assert.equal(config.attention.ai.maxBatchMessages, 12);
  assert.equal(config.attention.ai.maxBatchChars, 3000);
  assert.equal(config.attention.ai.requestsPerMinute, 15);
  assert.equal(config.attention.ai.openai.requestTimeoutMs, 4000);
  assert.equal(config.attention.ai.openai.model, "gpt-5.6-luna-test");
  assert.equal(config.attention.ai.openai.reasoningEffort, "medium");
  assert.equal(config.attention.ai.openai.baseUrl, "http://127.0.0.1:9000/v1");
  assert.equal(JSON.stringify(config).includes("must-not-enter-config"), false);
});

test("invalid AI provider settings retain safe defaults with diagnostics", () => {
  const diagnostics = [];
  const config = loadConfig({
    LIVE_ASSISTANT_AI_PROVIDER: "unknown",
    LIVE_ASSISTANT_AI_BATCH_WINDOW_MS: "0",
    LIVE_ASSISTANT_OPENAI_MODEL: "",
    LIVE_ASSISTANT_OPENAI_REASONING_EFFORT: "extreme",
    LIVE_ASSISTANT_OPENAI_BASE_URL: "https://secret@example.com/v1",
  }, (value) => diagnostics.push(value));
  assert.deepEqual(config.attention.ai, DEFAULT_CONFIG.attention.ai);
  assert.equal(diagnostics.length, 5);
});
