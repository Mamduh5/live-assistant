import test from "node:test";
import assert from "node:assert/strict";
import { AVAILABLE_CONNECTORS, aiProviderConfigurationIssue, cliOption, isAvailableConnector, normalizeTikTokUsername } from "../src/index.js";

test("explicit AI mode reports a clear startup issue when OPENAI_API_KEY is missing", () => {
  assert.deepEqual(aiProviderConfigurationIssue({ mode: "ai", provider: "openai", apiKey: "" }), {
    code: "cli.ai_provider_not_configured",
    provider: "openai",
    reason: "OPENAI_API_KEY is required when --attention=ai is selected",
  });
  assert.equal(aiProviderConfigurationIssue({ mode: "deterministic", provider: "openai", apiKey: "" }), null);
  assert.equal(aiProviderConfigurationIssue({ mode: "ai", provider: "openai", apiKey: "configured" }), null);
});

test("CLI TikTok browser username parsing strips a leading at-sign", () => {
  assert.equal(normalizeTikTokUsername('@synthetic_user'), 'synthetic_user');
});

test("CLI accepts assigned and separated TikTok browser options", () => {
  assert.equal(cliOption('--connector', ['--connector=tiktok-browser']), 'tiktok-browser');
  assert.equal(cliOption('--tiktok-user', ['--tiktok-user', '@synthetic_user']), '@synthetic_user');
  assert.equal(normalizeTikTokUsername(cliOption('--tiktok-user', [])), null);
});

test("CLI invalid connector output includes tiktok-browser", () => {
  assert.equal(isAvailableConnector('tiktok-browser'), true);
  assert.equal(isAvailableConnector('invalid'), false);
  assert.deepEqual(AVAILABLE_CONNECTORS, ['simulator', 'tikfinity', 'tiktok-browser']);
});
