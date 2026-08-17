import test from "node:test";
import assert from "node:assert/strict";
import {
  RawSimulatorConnector,
  SimulatorConnector,
  assertLiveEvent,
} from "../src/index.js";

test("canonical simulator emits valid events and reports lifecycle state", async () => {
  let nextId = 0;
  const connector = new SimulatorConnector({
    scenario: "quiet-chat",
    clock: () => 10,
    idFactory: () => `local-${++nextId}`,
  });
  const states = [];
  connector.subscribeState((state) => states.push(state));
  const events = [];
  for await (const event of connector.events()) events.push(assertLiveEvent(event));

  assert.deepEqual(events.map(({ id }) => id), ["local-1", "local-2"]);
  assert.deepEqual(states, ["idle", "connected", "disconnected"]);
});

test("raw simulator remains separate for normalizer testing", async () => {
  const connector = new RawSimulatorConnector({ scenario: "raw-malformed" });
  const payloads = [];
  for await (const payload of connector.events()) payloads.push(payload);
  assert.deepEqual(payloads, [null, "not-an-object", { kind: "comment", text: 42 }]);
});
