import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { SwarmSnapshot } from "../src/swarm-view.ts";

test("snapshot memory capture waits for idle work and retries failed extraction without losing full counts", async (t) => {
  const sessions = [
    { id: "coordinator-session", lastActivityAt: 10, working: false },
    { id: "builder-session", lastActivityAt: 20, working: true },
    { id: "reviewer-session", lastActivityAt: 30, working: false },
  ];
  const peers = sessions.map((session, index) => ({
    id: `member-${index}`,
    sessionId: session.id,
    threadRef: `swarm:${session.id}`,
    parentId: index ? "member-0" : undefined,
    depth: index ? 1 : 0,
    state: "ready",
    context: { group: "Storage" },
  }));
  let attempts = 0;
  let finishCapture!: () => void;
  let now = 100_000;
  const originalNow = Date.now;
  Date.now = () => now;
  const stubs = {
    inspectSwarm: async () => ({ peers, self: peers[0] }),
    readSwarmMessages: async () => [],
    readSwarmMemories: async () => ({
      memoryCount: 70,
      memoryCountsBySession: { "builder-session": 43, "reviewer-session": 27 },
      memoryStatus: "active",
      memories: [{ id: "memory-1", text: "Keep storage durable", source: "Memorable", sessionId: "builder-session" }],
    }),
    api: async () => ({ sessions }),
    captureSwarmMemories: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary extraction failure");
      if (attempts === 2)
        await new Promise<void>((resolve) => {
          finishCapture = resolve;
        });
    },
  };
  const stubKey = `swarmSnapshotTest${Date.now()}`;
  Object.defineProperty(globalThis, stubKey, { configurable: true, value: stubs });
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "swarm-snapshot-test-dependencies",
        enforce: "pre",
        resolveId(source, importer) {
          if (importer?.endsWith("/swarm-snapshot.ts") && ["./swarm-api", "./core-bridge"].includes(source))
            return `\0snapshot-test:${source}`;
        },
        load(id) {
          if (!id.startsWith("\0snapshot-test:")) return;
          const names = id.endsWith("core-bridge")
            ? ["api"]
            : ["inspectSwarm", "readSwarmMessages", "readSwarmMemories", "captureSwarmMemories"];
          return names
            .map(
              (name) => `export const ${name} = (...args) => globalThis[${JSON.stringify(stubKey)}].${name}(...args);`,
            )
            .join("\n");
        },
      },
    ],
  });
  t.after(async () => {
    Date.now = originalNow;
    Reflect.deleteProperty(globalThis, stubKey);
    await vite.close();
  });
  const { createSwarmSnapshotLoader } = (await vite.ssrLoadModule("/src/swarm-snapshot.ts")) as {
    createSwarmSnapshotLoader: (sessionId: string) => () => Promise<SwarmSnapshot>;
  };
  const load = createSwarmSnapshotLoader("coordinator-session");
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const workingSnapshot = await load();
  await flush();
  assert.equal(attempts, 0);
  assert.equal(workingSnapshot.features[0].memoryCount, 70);
  assert.equal(workingSnapshot.features[0].memories?.length, 1);

  sessions[1].working = false;
  await load();
  await flush();
  assert.equal(attempts, 1);
  now += 29_999;
  await load();
  await flush();
  assert.equal(attempts, 1);
  now++;
  await load();
  await flush();
  assert.equal(attempts, 2);
  await load();
  await flush();
  assert.equal(attempts, 2);
  finishCapture();
  await flush();
  await load();
  await flush();
  assert.equal(attempts, 2);

  sessions[2].working = true;
  sessions[2].lastActivityAt++;
  now += 30_000;
  await load();
  await flush();
  assert.equal(attempts, 2);
  sessions[2].working = false;
  await load();
  await flush();
  assert.equal(attempts, 3);
});
