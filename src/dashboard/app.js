const state = { status: null, events: [], attention: [], diagnostics: [], selectedEventId: null, selectedAttentionId: null };
const byId = (id) => document.getElementById(id);

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderPairs(target, pairs) {
  target.replaceChildren();
  for (const [label, value] of pairs) {
    target.append(textElement("dt", label), textElement("dd", String(value ?? "—")));
  }
}

function renderStatus() {
  if (!state.status) return;
  const { runtime, connector, speech, attention } = state.status;
  const runtimeState = byId("runtime-state");
  runtimeState.textContent = runtime.state;
  runtimeState.dataset.state = runtime.state;
  renderPairs(byId("connector-status"), [
    ["Name", connector.name], ["State", connector.state], ["Endpoint", connector.endpoint],
  ]);
  renderPairs(byId("speech-status"), [
    ["Engine", speech.configuredEngine], ["Worker", speech.workerState],
    ["Paused", speech.paused ? "yes" : "no"], ["Queue", speech.queueSize],
    ["Voice", speech.voice], ["Rate / volume", speech.rate === undefined ? null : `${speech.rate} / ${speech.volume}`],
  ]);
  renderPairs(byId("attention-status"), [
    ["Mode", attention.mode], ["Traffic", attention.trafficLevel],
    ["Recent chat", attention.recentChatCount], ["Pending groups", attention.pendingGroupCount],
    ["Recent decisions", attention.decisionHistorySize],
  ]);
  byId("pause-speech").disabled = !speech.enabled || speech.paused || speech.workerState === "stopped";
  byId("resume-speech").disabled = !speech.enabled || !speech.paused || speech.workerState === "stopped";
  byId("cancel-speech").disabled = !speech.enabled || !speech.currentRequestId;
  byId("clear-speech").disabled = !speech.enabled || speech.queueSize === 0;
}

function renderAttention() {
  const feed = byId("attention-feed");
  feed.replaceChildren();
  for (const decision of [...state.attention].reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attention-row";
    button.append(
      textElement("time", new Date(decision.createdAt).toLocaleTimeString(), "event-time"),
      textElement("span", decision.classification, "event-type"),
      textElement("span", `${decision.action} · ${decision.priority}`, `attention-action ${decision.action}`),
      textElement("span", decision.reason, "attention-reason"),
      textElement("span", decision.group ? `group ${decision.group.occurrences} / ${decision.group.uniqueUsers} viewers` : "single", "attention-group"),
      textElement("span", decision.displayText ?? "—", "event-summary"),
    );
    button.addEventListener("click", () => {
      state.selectedAttentionId = decision.id;
      byId("attention-detail").textContent = JSON.stringify(decision, null, 2);
    });
    const item = document.createElement("li");
    item.append(button);
    feed.append(item);
  }
}

function renderEvents() {
  const feed = byId("event-feed");
  feed.replaceChildren();
  for (const event of [...state.events].reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "event-row";
    button.append(
      textElement("time", new Date(event.timestamp).toLocaleTimeString(), "event-time"),
      textElement("span", event.type, "event-type"),
      textElement("span", event.user?.displayName ?? event.user?.username ?? "—", "event-user"),
      textElement("span", event.summary, "event-summary"),
    );
    button.addEventListener("click", () => {
      state.selectedEventId = event.id;
      byId("event-detail").textContent = JSON.stringify(event, null, 2);
    });
    const item = document.createElement("li");
    item.append(button);
    feed.append(item);
  }
}

function renderDiagnostics() {
  const list = byId("diagnostics");
  list.replaceChildren();
  for (const diagnostic of [...state.diagnostics].reverse().slice(0, 20)) {
    const item = textElement("li", `${diagnostic.code} · ${new Date(diagnostic.timestamp).toLocaleTimeString()}`);
    list.append(item);
  }
}

async function loadSnapshot() {
  const [statusResponse, eventsResponse, attentionResponse] = await Promise.all([
    fetch("/api/v1/status"), fetch("/api/v1/events?limit=100"), fetch("/api/v1/attention?limit=100"),
  ]);
  state.status = await statusResponse.json();
  state.events = (await eventsResponse.json()).events;
  state.attention = (await attentionResponse.json()).decisions;
  renderStatus();
  renderEvents();
  renderAttention();
}

async function command(path) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "Control request failed");
  await loadSnapshot();
}

for (const [id, path] of [
  ["pause-speech", "/api/v1/speech/pause"],
  ["resume-speech", "/api/v1/speech/resume"],
  ["cancel-speech", "/api/v1/speech/cancel-current"],
  ["clear-speech", "/api/v1/speech/clear"],
]) {
  byId(id).addEventListener("click", () => command(path).catch((error) => {
    state.diagnostics.push({ code: `control: ${error.message}`, timestamp: Date.now() });
    renderDiagnostics();
  }));
}

const stream = new EventSource("/api/v1/stream");
stream.addEventListener("open", () => { byId("stream-state").textContent = "Live"; });
stream.addEventListener("error", () => {
  byId("stream-state").textContent = "Reconnecting…";
  loadSnapshot().catch(() => {});
});
stream.addEventListener("snapshot", (message) => {
  const snapshot = JSON.parse(message.data);
  state.status = snapshot.status;
  state.events = snapshot.events;
  state.attention = snapshot.attention;
  state.diagnostics = snapshot.diagnostics;
  renderStatus(); renderEvents(); renderAttention(); renderDiagnostics();
});
stream.addEventListener("live-event", (message) => {
  state.events.push(JSON.parse(message.data));
  state.events = state.events.slice(-200);
  renderEvents();
});
stream.addEventListener("attention-decision", (message) => {
  state.attention.push(JSON.parse(message.data));
  state.attention = state.attention.slice(-200);
  renderAttention();
});
stream.addEventListener("connector-state", (message) => {
  state.status.connector = JSON.parse(message.data); renderStatus();
});
stream.addEventListener("speech-state", (message) => {
  state.status.speech = JSON.parse(message.data); renderStatus();
});
stream.addEventListener("diagnostic", (message) => {
  state.diagnostics.push(JSON.parse(message.data)); renderDiagnostics();
});
stream.addEventListener("stream-gap", () => { loadSnapshot().catch(() => {}); });

loadSnapshot().catch(() => { byId("runtime-state").textContent = "Unavailable"; });
