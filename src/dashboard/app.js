const state = { status: null, events: [], diagnostics: [], selectedEventId: null };
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
  const { runtime, connector, speech } = state.status;
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
  byId("pause-speech").disabled = !speech.enabled || speech.paused || speech.workerState === "stopped";
  byId("resume-speech").disabled = !speech.enabled || !speech.paused || speech.workerState === "stopped";
  byId("cancel-speech").disabled = !speech.enabled || !speech.currentRequestId;
  byId("clear-speech").disabled = !speech.enabled || speech.queueSize === 0;
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
  const [statusResponse, eventsResponse] = await Promise.all([
    fetch("/api/v1/status"), fetch("/api/v1/events?limit=100"),
  ]);
  state.status = await statusResponse.json();
  state.events = (await eventsResponse.json()).events;
  renderStatus();
  renderEvents();
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
  state.diagnostics = snapshot.diagnostics;
  renderStatus(); renderEvents(); renderDiagnostics();
});
stream.addEventListener("live-event", (message) => {
  state.events.push(JSON.parse(message.data));
  state.events = state.events.slice(-200);
  renderEvents();
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
