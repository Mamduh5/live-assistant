import test from "node:test";
import assert from "node:assert/strict";
import { aiProviderConfigurationIssue } from "../src/index.js";

test("explicit AI mode reports a clear startup issue when OPENAI_API_KEY is missing", () => {
  assert.deepEqual(aiProviderConfigurationIssue({ mode: "ai", provider: "openai", apiKey: "" }), {
    code: "cli.ai_provider_not_configured",
    provider: "openai",
    reason: "OPENAI_API_KEY is required when --attention=ai is selected",
  });
  assert.equal(aiProviderConfigurationIssue({ mode: "deterministic", provider: "openai", apiKey: "" }), null);
  assert.equal(aiProviderConfigurationIssue({ mode: "ai", provider: "openai", apiKey: "configured" }), null);
});
