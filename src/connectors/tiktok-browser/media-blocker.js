const MEDIA_URL_MARKERS = Object.freeze([
  ".flv",
  ".m3u8",
  ".mp4",
  ".m4s",
  ".webm",
  ".mp3",
  ".aac",
  ".m4a",
  ".ogg",
  ".wav",
  "pull-flv",
  "pull-hls",
]);

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:https?|wss?):\/\/\S+/giu, "[redacted-url]").replace(/[\r\n\t]/gu, " ").slice(0, 240);
}

export function classifyTikTokPresentationRequest({ url, resourceType } = {}) {
  if (resourceType === "Media") return "media";
  if (resourceType === "Image") return "image";
  if (resourceType === "Font") return "font";
  if (typeof url !== "string") return null;
  let classifiedUrl;
  try {
    const parsed = new URL(url);
    classifiedUrl = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    [classifiedUrl] = url.split(/[?#]/u, 1);
  }
  const lower = classifiedUrl.toLowerCase();
  return MEDIA_URL_MARKERS.some((marker) => lower.includes(marker)) ? "media" : null;
}

export function shouldBlockTikTokMedia(request) {
  return classifyTikTokPresentationRequest(request) !== null;
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
    const category = classifyTikTokPresentationRequest({
      url: params.request?.url,
      resourceType: params.resourceType,
    });
    const blocked = category !== null;
    const method = blocked ? "Fetch.failRequest" : "Fetch.continueRequest";
    const commandParams = blocked
      ? { requestId: params.requestId, errorReason: "Aborted" }
      : { requestId: params.requestId };
    try {
      await client.send(method, commandParams, { sessionId });
      if (blocked) onBlocked(category);
    } catch (error) {
      onDiagnostic({
        code: "tiktok_browser.media_request_resolution_failed",
        action: blocked ? "block" : "continue",
        error: errorMessage(error),
      });
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
