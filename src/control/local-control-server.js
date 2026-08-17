import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { RuntimeControlError } from "../live/live-assistant-runtime.js";
import { SseBroker } from "./sse-broker.js";

const STATIC_FILES = new Map([
  ["/", [new URL("../dashboard/index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/app.js", [new URL("../dashboard/app.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/styles.css", [new URL("../dashboard/styles.css", import.meta.url), "text/css; charset=utf-8"]],
]);

const CONTROL_ROUTES = new Map([
  ["/api/v1/speech/pause", "pauseSpeech"],
  ["/api/v1/speech/resume", "resumeSpeech"],
  ["/api/v1/speech/clear", "clearSpeechQueue"],
  ["/api/v1/speech/cancel-current", "cancelCurrentSpeech"],
]);

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
});

function json(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function apiError(response, statusCode, code, message, headers) {
  json(response, statusCode, { error: { code, message } }, headers);
}

function readBoundedBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error("Request body is too large"), { code: "body_too_large" }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host;
}

export class LocalControlServer {
  #runtime;
  #host;
  #port;
  #maxBodyBytes;
  #server;
  #broker;
  #unsubscribe;
  #onDiagnostic;
  #stopPromise;
  #url;

  constructor({ runtime, host = "127.0.0.1", port = 4820, maxBodyBytes = 4096, maxSseClients = 32, onDiagnostic = () => {} }) {
    if (!runtime || typeof runtime.getStatus !== "function") throw new TypeError("Control server requires a runtime");
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("Control server port is invalid");
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError("Control request limit must be positive");
    this.#runtime = runtime;
    this.#host = host;
    this.#port = port;
    this.#maxBodyBytes = maxBodyBytes;
    this.#onDiagnostic = onDiagnostic;
    this.#broker = new SseBroker({ maxClients: maxSseClients, onDiagnostic });
  }

  async start() {
    if (this.#server) return this.#url;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        this.#onDiagnostic({ code: "control_request.failed" });
        if (!response.headersSent) apiError(response, 500, "internal_error", "The request could not be completed");
        else response.end();
      });
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.#server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.#server.removeListener("error", onError);
          resolve();
        };
        this.#server.once("error", onError);
        this.#server.once("listening", onListening);
        this.#server.listen(this.#port, this.#host);
      });
    } catch (error) {
      this.#server = undefined;
      this.#onDiagnostic({ code: "control_server.failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    const address = this.#server.address();
    const actualPort = typeof address === "object" && address ? address.port : this.#port;
    this.#url = `http://${hostForUrl(this.#host)}:${actualPort}/`;
    this.#unsubscribe = this.#runtime.subscribe((message) => {
      if (message.type === "runtime-state") this.#broker.broadcast("snapshot", this.#runtime.getSnapshot());
      else if (["live-event", "attention-decision", "connector-state", "speech-state", "diagnostic"].includes(message.type)) {
        this.#broker.broadcast(message.type, message.data);
      }
    });
    this.#onDiagnostic({ code: "control_server.started" });
    return this.#url;
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#broker.close();
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    this.#onDiagnostic({ code: "control_server.stopped" });
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? "/", "http://local.invalid");
    const path = url.pathname;

    if (path === "/api/v1/health") {
      if (request.method !== "GET") return this.#wrongMethod(response, "GET");
      return json(response, 200, { ok: true });
    }
    if (path === "/api/v1/status") {
      if (request.method !== "GET") return this.#wrongMethod(response, "GET");
      return json(response, 200, this.#runtime.getStatus());
    }
    if (path === "/api/v1/events") {
      if (request.method !== "GET") return this.#wrongMethod(response, "GET");
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 0) return apiError(response, 400, "invalid_limit", "limit must be a non-negative integer");
      return json(response, 200, { events: this.#runtime.getRecentEvents({ limit }) });
    }
    if (path === "/api/v1/attention") {
      if (request.method !== "GET") return this.#wrongMethod(response, "GET");
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 0) return apiError(response, 400, "invalid_limit", "limit must be a non-negative integer");
      return json(response, 200, {
        decisions: this.#runtime.getRecentAttention({ limit: Math.min(limit, 200) }),
      });
    }
    if (path === "/api/v1/stream") {
      if (request.method !== "GET") return this.#wrongMethod(response, "GET");
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      const remove = this.#broker.add(response, this.#runtime.getSnapshot());
      if (!remove) {
        response.end();
        return;
      }
      return;
    }
    if (CONTROL_ROUTES.has(path)) {
      if (request.method !== "POST") return this.#wrongMethod(response, "POST");
      if (!this.#originAllowed(request)) {
        this.#onDiagnostic({ code: "control_request.rejected_origin" });
        return apiError(response, 403, "origin_rejected", "Cross-origin control requests are not allowed");
      }
      if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return apiError(response, 415, "json_required", "Control requests require application/json");
      }
      const contentLength = Number(request.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > this.#maxBodyBytes) {
        request.resume();
        return apiError(response, 413, "body_too_large", "Request body is too large");
      }
      let body;
      try {
        body = await readBoundedBody(request, this.#maxBodyBytes);
      } catch (error) {
        if (error?.code === "body_too_large") return apiError(response, 413, "body_too_large", "Request body is too large");
        throw error;
      }
      try {
        const command = JSON.parse(body);
        if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("invalid command");
      } catch {
        this.#onDiagnostic({ code: "control_request.invalid" });
        return apiError(response, 400, "invalid_json", "A JSON object body is required");
      }
      try {
        const result = this.#runtime[CONTROL_ROUTES.get(path)]();
        return json(response, 200, { ok: true, result });
      } catch (error) {
        if (error instanceof RuntimeControlError || (error && typeof error.code === "string")) {
          return apiError(response, error.statusCode ?? 409, error.code, error.message);
        }
        throw error;
      }
    }

    if (STATIC_FILES.has(path)) {
      if (request.method !== "GET" && request.method !== "HEAD") return this.#wrongMethod(response, "GET, HEAD");
      const [file, contentType] = STATIC_FILES.get(path);
      const content = await readFile(file);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-cache",
        "Content-Type": contentType,
      });
      return response.end(request.method === "HEAD" ? undefined : content);
    }

    return apiError(response, 404, "not_found", "Route not found");
  }

  #originAllowed(request) {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    const origin = request.headers.origin;
    return origin === undefined || `${origin}/` === this.#url;
  }

  #wrongMethod(response, allowed) {
    return apiError(response, 405, "method_not_allowed", "Method not allowed", { Allow: allowed });
  }

  get url() {
    return this.#url;
  }

  get host() {
    return this.#host;
  }

  get sseClientCount() {
    return this.#broker.clientCount;
  }
}
