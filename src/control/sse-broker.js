function encodeEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseBroker {
  #clients = new Set();
  #maxClients;
  #onDiagnostic;

  constructor({ maxClients = 32, onDiagnostic = () => {} } = {}) {
    if (!Number.isSafeInteger(maxClients) || maxClients < 1) throw new RangeError("SSE client limit must be positive");
    this.#maxClients = maxClients;
    this.#onDiagnostic = onDiagnostic;
  }

  add(response, snapshot) {
    if (this.#clients.size >= this.#maxClients) return null;
    const client = { response, blocked: false, dropped: 0 };
    const onClose = () => this.#remove(client);
    const onDrain = () => {
      if (!this.#clients.has(client)) return;
      client.blocked = false;
      if (client.dropped > 0) {
        const dropped = client.dropped;
        client.dropped = 0;
        this.#write(client, "stream-gap", { dropped, resync: true });
      }
    };
    client.cleanup = () => {
      response.removeListener("close", onClose);
      response.removeListener("drain", onDrain);
    };
    response.on("close", onClose);
    response.on("drain", onDrain);
    this.#clients.add(client);
    this.#write(client, "snapshot", snapshot);
    this.#onDiagnostic({ code: "sse.connected" });
    return () => this.#remove(client);
  }

  broadcast(name, data) {
    for (const client of this.#clients) {
      if (client.blocked) {
        client.dropped += 1;
        continue;
      }
      this.#write(client, name, data);
    }
  }

  close() {
    for (const client of [...this.#clients]) {
      client.cleanup();
      this.#clients.delete(client);
      client.response.end();
    }
  }

  #write(client, name, data) {
    try {
      if (!client.response.write(encodeEvent(name, data))) {
        client.blocked = true;
        this.#onDiagnostic({ code: "sse.backpressure" });
      }
    } catch {
      this.#remove(client);
    }
  }

  #remove(client) {
    if (!this.#clients.delete(client)) return;
    client.cleanup();
    this.#onDiagnostic({ code: "sse.disconnected" });
  }

  get clientCount() {
    return this.#clients.size;
  }
}
