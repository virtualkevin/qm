import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmSnapshot } from "../src/swarm-data.ts";
import type { SwarmInspection, SwarmMember, SwarmMessage } from "../src/swarm-api.ts";

function member(id: string, overrides: Partial<SwarmMember> = {}): SwarmMember {
  return { id, threadRef: `swarm:${id}`, depth: 1, context: null, state: "ready", attempts: 1, ...overrides };
}

const root = member("root", { depth: 0 });

function inspect(peers: SwarmMember[]): SwarmInspection {
  return {
    id: "swarm-1",
    self: root,
    peers,
    backend: "local",
    settings: {
      agents: 32,
      depth: 4,
      messages: 128,
      notifications: 256,
      spawnRequests: 32,
      contextBytes: 8192,
      textBytes: 8192,
      waitMs: 10000,
      turnMs: 600000,
      lifetimeMs: 3600000,
    },
    expiresAt: Date.now() + 60000,
  };
}

function message(id: string, overrides: Partial<SwarmMessage> = {}): SwarmMessage {
  return {
    id,
    seq: 1,
    senderId: "root",
    senderSessionId: "root-session",
    author: "human",
    actorId: "alice",
    text: "Please check the layout",
    audience: ["worker"],
    createdAt: 1000,
    notifications: {},
    ...overrides,
  };
}

test("groups real worker context and preserves provisioning status without inventing progress", () => {
  const inspection = inspect([
    root,
    member("worker", { parentId: "root", context: { name: "Iris", role: "Reviewer", group: "Layout" } }),
    member("reserved", { parentId: "worker", state: "reserved", context: { group: "Layout" } }),
    member("failed", {
      parentId: "root",
      state: "failed",
      context: { group: "Layout" },
      error: "Computer unavailable",
    }),
  ]);
  const snapshot = swarmSnapshot(inspection, []);
  assert.deepEqual(snapshot.features, [
    { id: "feature:Layout", name: "Layout", status: "blocked", summary: "1 ready · 1 provisioning · 1 failed" },
  ]);
  assert.equal(snapshot.agents[0]?.featureId, undefined);
  assert.equal(snapshot.agents[1]?.name, "Iris");
  assert.equal(snapshot.agents[1]?.role, "Reviewer");
  assert.equal(snapshot.agents[1]?.state, "idle");
  assert.equal(snapshot.agents[2]?.state, "traveling");
  assert.equal(snapshot.agents[3]?.state, "blocked");
  assert.equal(snapshot.agents[3]?.summary, "Computer unavailable");
});

test("arbitrary JSON context remains safe and workers without a group stay visible", () => {
  const snapshot = swarmSnapshot(
    inspect([
      root,
      member("worker", { parentId: "root", context: ["planner"] }),
      member("other", { parentId: "root", context: "reviewer" }),
    ]),
    [],
  );
  assert.equal(snapshot.features.length, 1);
  assert.equal(snapshot.features[0]?.name, "Worker pool");
  assert.equal(snapshot.agents.length, 3);
});

test("message pulses follow intended recipients and human authors remain instructions", () => {
  const snapshot = swarmSnapshot(inspect([root, member("worker", { parentId: "root" })]), [
    message("human", { audience: ["worker", "root"] }),
    message("reply", { seq: 2, senderId: "worker", author: "agent", audience: ["root"], text: "Layout checked" }),
    message("shared", { seq: 3, audience: [] }),
  ]);
  assert.equal(snapshot.messages.length, 4);
  assert.deepEqual(
    snapshot.messages.map((item) => [item.fromId, item.toId, item.kind]),
    [
      ["root", "", "instruction"],
      ["worker", "root", "status"],
      ["root", "worker", "instruction"],
      ["root", "root", "instruction"],
    ],
  );
  assert.equal(snapshot.agents[1]?.summary, "Layout checked");
  assert.equal(snapshot.messages[2]?.id, snapshot.messages[3]?.id);
  assert.equal(snapshot.features[0]?.status, "idle");
});

test("live session activity distinguishes working, idle, and awaiting input", () => {
  const inspection = inspect([
    root,
    member("worker", { parentId: "root", sessionId: "working-session" }),
    member("waiting", { parentId: "root", sessionId: "waiting-session" }),
    member("idle", { parentId: "root", sessionId: "idle-session" }),
    member("failed", { parentId: "root", state: "failed", sessionId: "failed-session" }),
  ]);
  const snapshot = swarmSnapshot(
    inspection,
    [],
    [
      { id: "working-session", working: true },
      { id: "waiting-session", awaitingInput: true, working: true },
      { id: "idle-session", working: false },
      { id: "failed-session", working: true },
    ],
  );
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.state),
    ["idle", "working", "blocked", "idle", "blocked"],
  );
  assert.equal(snapshot.features[0]?.status, "blocked");
  assert.equal(snapshot.features[0]?.summary, "1 working · 1 ready · 1 awaiting input · 1 failed");
});

test("delegated helpers stay with their nearest feature ancestor unless they name a new planet", () => {
  const snapshot = swarmSnapshot(
    inspect([
      root,
      member("nested", { parentId: "helper", context: ["check storage"] }),
      member("helper", { parentId: "builder", context: { role: "Tester" } }),
      member("new-planet", { parentId: "builder", context: { feature: "Accessibility" } }),
      member("new-helper", { parentId: "new-planet", context: "review" }),
      member("builder", { parentId: "root", context: { group: "Storage" } }),
    ]),
    [],
  );
  const features = Object.fromEntries(snapshot.agents.map((agent) => [agent.id, agent.featureId]));
  assert.equal(snapshot.features.length, 2);
  assert.equal(features.nested, "feature:Storage");
  assert.equal(features.helper, "feature:Storage");
  assert.equal(features.builder, "feature:Storage");
  assert.equal(features["new-planet"], "feature:Accessibility");
  assert.equal(features["new-helper"], "feature:Accessibility");
});

test("missing or cyclic parent records leave unnamed workers visible without looping", () => {
  const snapshot = swarmSnapshot(
    inspect([
      root,
      member("orphan", { parentId: "missing" }),
      member("cycle-a", { parentId: "cycle-b" }),
      member("cycle-b", { parentId: "cycle-a" }),
    ]),
    [],
  );
  assert.equal(snapshot.features.length, 1);
  assert.equal(snapshot.features[0]?.name, "Worker pool");
  assert.equal(snapshot.agents.length, 4);
});
