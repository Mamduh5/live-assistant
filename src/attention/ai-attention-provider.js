import {
  AI_ATTENTION_INSTRUCTIONS,
  AI_ATTENTION_PROMPT_VERSION,
  AI_ATTENTION_RESPONSE_SCHEMA,
  AI_REASON_CODES,
} from "./ai-attention-prompt.js";

const CLASSIFICATIONS = new Set(["question", "message", "low_information"]);
const REASONS = new Set(AI_REASON_CODES);
const GROUP_KEYS = ["classification", "importance", "itemIds", "reason", "summary"];
const MAX_ERROR_CODE_CHARS = 80;

export class AiProviderError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.metadata = metadata;
  }
}

export function aiProviderConfigurationIssue({ mode, provider, apiKey }) {
  if (mode !== "ai" || provider !== "openai" || apiKey) return null;
  return {
    code: "cli.ai_provider_not_configured",
    provider: "openai",
    reason: "OPENAI_API_KEY is required when --attention=ai is selected",
  };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

export function validateAiAnalysis(value, itemIds, { maxSummaryChars }) {
  if (!exactKeys(value, ["groups"]) || !Array.isArray(value.groups)) {
    throw new AiProviderError("provider_invalid_response", "AI result must contain only groups");
  }
  const expected = new Set(itemIds);
  const assigned = new Set();
  for (const group of value.groups) {
    if (!exactKeys(group, GROUP_KEYS)) throw new AiProviderError("provider_invalid_response", "AI group fields are invalid");
    if (!Array.isArray(group.itemIds) || group.itemIds.length === 0 || group.itemIds.some((id) => typeof id !== "string")) {
      throw new AiProviderError("provider_invalid_response", "AI group item IDs are invalid");
    }
    if (!CLASSIFICATIONS.has(group.classification)) throw new AiProviderError("provider_invalid_response", "AI classification is invalid");
    if (!Number.isSafeInteger(group.importance) || group.importance < 0 || group.importance > 100) {
      throw new AiProviderError("provider_invalid_response", "AI importance is invalid");
    }
    if (!REASONS.has(group.reason)) throw new AiProviderError("provider_invalid_response", "AI reason is invalid");
    if (typeof group.summary !== "string" || group.summary.trim().length === 0 || group.summary.length > maxSummaryChars) {
      throw new AiProviderError("provider_invalid_response", "AI summary is invalid");
    }
    for (const id of group.itemIds) {
      if (!expected.has(id) || assigned.has(id)) throw new AiProviderError("provider_invalid_response", "AI item mapping is invalid");
      assigned.add(id);
    }
  }
  if (assigned.size !== expected.size) throw new AiProviderError("provider_invalid_response", "AI result does not cover every item");
  return value;
}

function responseText(response) {
  if (!Array.isArray(response?.output)) throw new AiProviderError("provider_invalid_response", "OpenAI response output is missing");
  for (const item of response.output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === "refusal") throw new AiProviderError("provider_refusal", "OpenAI refused the attention request");
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new AiProviderError("provider_invalid_response", "OpenAI structured output text is missing");
}

async function readBoundedBody(response, maximumBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new AiProviderError("provider_response_too_large", "OpenAI response exceeded its size limit");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new AiProviderError("provider_response_too_large", "OpenAI response exceeded its size limit");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function safeProviderErrorCode(body) {
  try {
    const code = JSON.parse(body)?.error?.code;
    return typeof code === "string" ? code.slice(0, MAX_ERROR_CODE_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

export class OpenAiAttentionProvider {
  #config;
  #apiKey;
  #fetch;
  #clock;
  #setTimeout;
  #clearTimeout;
  #controllers = new Set();
  #closed = false;
  #status;

  constructor({ config, apiKey, fetchFn = fetch, clock = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("AI attention with OpenAI requires OPENAI_API_KEY");
    this.#config = config;
    this.#apiKey = apiKey;
    this.#fetch = fetchFn;
    this.#clock = clock;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#status = {
      name: "openai",
      model: config.model,
      state: "idle",
      requests: 0,
      successes: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastLatencyMs: null,
    };
  }

  async analyzeBatch(batch, { signal } = {}) {
    if (this.#closed) throw new AiProviderError("provider_unavailable", "OpenAI attention provider is closed");
    const controller = new AbortController();
    const startedAt = this.#clock();
    let timedOut = false;
    const timeout = this.#setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#config.requestTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#controllers.add(controller);
    this.#status.requests += 1;
    try {
      const body = {
        model: this.#config.model,
        store: false,
        reasoning: { effort: this.#config.reasoningEffort },
        text: {
          verbosity: this.#config.verbosity,
          format: {
            type: "json_schema",
            name: "live_assistant_attention",
            description: "Semantic attention groups for one bounded livestream chat batch",
            strict: true,
            schema: AI_ATTENTION_RESPONSE_SCHEMA,
          },
        },
        instructions: AI_ATTENTION_INSTRUCTIONS,
        input: [{
          role: "user",
          content: [{
            type: "input_text",
            text: JSON.stringify({ promptVersion: AI_ATTENTION_PROMPT_VERSION, items: batch.items }),
          }],
        }],
        tools: [],
      };
      let response;
      try {
        response = await this.#fetch(new URL("responses", `${this.#config.baseUrl.replace(/\/$/u, "")}/`), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new AiProviderError("provider_timeout", "OpenAI attention request timed out");
        if (controller.signal.aborted) throw new AiProviderError("provider_aborted", "OpenAI attention request was aborted");
        throw new AiProviderError("provider_network_error", "OpenAI attention request failed");
      }
      const responseBody = await readBoundedBody(response, this.#config.maxResponseBytes);
      if (!response.ok) {
        throw new AiProviderError("provider_http_error", `OpenAI returned HTTP ${response.status}`, {
          status: response.status,
          providerCode: safeProviderErrorCode(responseBody),
          requestId: response.headers?.get?.("x-request-id")?.slice(0, 100),
        });
      }
      let envelope;
      try {
        envelope = JSON.parse(responseBody);
      } catch {
        throw new AiProviderError("provider_invalid_json", "OpenAI returned malformed JSON");
      }
      if (envelope.status && envelope.status !== "completed") {
        throw new AiProviderError(envelope.status === "incomplete" ? "provider_incomplete" : "provider_invalid_response", "OpenAI response did not complete");
      }
      let analysis;
      try {
        analysis = JSON.parse(responseText(envelope));
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        throw new AiProviderError("provider_invalid_response", "OpenAI structured output was not valid JSON");
      }
      validateAiAnalysis(analysis, batch.items.map(({ itemId }) => itemId), {
        maxSummaryChars: batch.maxSummaryChars,
      });
      this.#status.successes += 1;
      this.#status.state = "healthy";
      this.#status.inputTokens += Number.isSafeInteger(envelope.usage?.input_tokens) ? envelope.usage.input_tokens : 0;
      this.#status.outputTokens += Number.isSafeInteger(envelope.usage?.output_tokens) ? envelope.usage.output_tokens : 0;
      return analysis;
    } catch (error) {
      this.#status.failures += 1;
      this.#status.state = this.#closed ? "unavailable" : "degraded";
      if (!(error instanceof AiProviderError) && timedOut) throw new AiProviderError("provider_timeout", "OpenAI attention request timed out");
      if (!(error instanceof AiProviderError) && controller.signal.aborted) throw new AiProviderError("provider_aborted", "OpenAI attention request was aborted");
      throw error instanceof AiProviderError ? error : new AiProviderError("provider_invalid_response", "OpenAI provider failed");
    } finally {
      this.#clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
      this.#status.lastLatencyMs = Math.max(0, this.#clock() - startedAt);
    }
  }

  getStatus() {
    return { ...this.#status };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#status.state = "unavailable";
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }
}
