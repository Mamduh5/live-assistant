const MEDIA_URL_MARKERS = Object.freeze([
  ".flv",
  ".m3u8",
  ".mp4",
  ".m4s",
  "pull-flv",
  "pull-hls",
]);

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:https?|wss?):\/\/\S+/giu, "[redacted-url]").replace(/[\r\n\t]/gu, " ").slice(0, 240);
}

export function shouldBlockTikTokMedia({ url, resourceType } = {}) {
  if (resourceType === "Media") return true;
  if (typeof url !== "string") return false;
  let classifiedUrl;
  try {
    const parsed = new URL(url);
    classifiedUrl = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    [classifiedUrl] = url.split(/[?#]/u, 1);
  }
  const lower = classifiedUrl.toLowerCase();
  return MEDIA_URL_MARKERS.some((marker) => lower.includes(marker));
}

export async function installTikTokMediaBlocker(client, {
  sessionId,
  onBlocked = () => {},
  onDiagnostic = () => {},
  signal,
} = {}) {
  let closing = false;
  const pending = new Set();

  const resolvePausedRequest = async (params) => {
    const blocked = shouldBlockTikTokMedia({
      url: params.request?.url,
      resourceType: params.resourceType,
    });
    const method = blocked ? "Fetch.failRequest" : "Fetch.continueRequest";
    const commandParams = blocked
      ? { requestId: params.requestId, errorReason: "Aborted" }
      : { requestId: params.requestId };
    try {
      await client.send(method, commandParams, { sessionId });
      if (blocked) onBlocked();
    } catch (error) {
      onDiagnostic({
        code: "tiktok_browser.media_request_resolution_failed",
        action: blocked ? "block" : "continue",
        error: errorMessage(error),
      });
      if (blocked && !closing) {
        try {
          await client.send("Fetch.continueRequest", { requestId: params.requestId }, { sessionId });
        } catch (fallbackError) {
          onDiagnostic({
            code: "tiktok_browser.media_request_resolution_failed",
            action: "fallback_continue",
            error: errorMessage(fallbackError),
          });
        }
      }
    }
  };

  const unsubscribe = client.subscribe("Fetch.requestPaused", (params) => {
    const operation = resolvePausedRequest(params).finally(() => pending.delete(operation));
    pending.add(operation);
  }, { sessionId });

  try {
    await client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    }, { sessionId, signal });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  return async () => {
    if (closing) return;
    closing = true;
    try {
      await client.send("Fetch.disable", {}, { sessionId, signal: AbortSignal.timeout(1_000) });
    } catch (error) {
      if (!client.closed) onDiagnostic({ code: "tiktok_browser.media_blocker_cleanup_failed", error: errorMessage(error) });
    } finally {
      unsubscribe();
      await Promise.allSettled([...pending]);
    }
  };
}
