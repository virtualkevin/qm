import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";

test("feature memories authenticate viewers, wait for completed threads and capture actual member sessions", async (t) => {
  const secret = "swarm-memories-source-secret-distinct";
  const portalSecret = "swarm-memories-portal-secret-distinct";
  const captured: string[] = [];
  const checked: string[] = [];
  let busy = true;
  let workerVisible = true;
  let workerScope = "personal:alice";
  let workerThreadRef = "swarm:worker-thread";
  let inspections = 0;
  const app = {
    getSessionForViewer: async (id: string, actor: string) => {
      if (actor !== "alice") return null;
      if (id === "feature-root") return { session: { scopeId: "personal:alice", threadRef: "web:alice:feature" } };
      return id === "worker-session" && workerVisible
        ? { session: { scopeId: workerScope, threadRef: workerThreadRef } }
        : null;
    },
    swarms: {
      inspect: async () => ({
        self: { sessionId: "feature-root", threadRef: "web:alice:feature" },
        peers: [{ sessionId: "worker-session", threadRef: "swarm:worker-thread" }],
      }),
    },
  } as unknown as App;
  const server = createServer(app, {
    signingSecret: secret,
    capabilitySecret: "swarm-memories-capability-secret-distinct",
    portalIdentitySecret: portalSecret,
    requireSignedPortalIdentity: true,
    runs: {
      inFlightForThread: async (threadRef: string) => {
        checked.push(threadRef);
        return busy ? [{ status: "running" }] : [];
      },
    } as unknown as RunStore,
    memory: {
      capture: async (_scope, facts, _at, _author, context) => {
        assert.deepEqual(facts, []);
        assert.equal(context?.mode, "automatic");
        captured.push(context!.sessionId!);
        return 1;
      },
    } as MemoryService,
    memorable: {
      inspect: async (scope, sessions) => {
        inspections++;
        assert.equal(scope, "personal:alice");
        assert.deepEqual(sessions, ["feature-root", "worker-session"]);
        return { memoryCount: 2, memoryCountsBySession: { "worker-session": 2 }, memories: [], memoryStatus: "active" };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const path = "/v1/sessions/feature-root/swarm/memories";
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
  let request = 0;
  const post = async (actor: string) => {
    const identity = await mintPortalIdentity({ p: actor, exp: Date.now() + 60_000 }, portalSecret);
    const body = JSON.stringify({ requestId: ++request });
    return fetch(url, {
      method: "POST",
      body,
      headers: signedRequestHeaders(secret, "POST", path, body, {
        "x-portal-identity": identity,
        "content-type": "application/json",
      }),
    });
  };
  try {
    assert.equal((await post("bob")).status, 403);
    assert.equal((await post("alice")).status, 409);
    assert.deepEqual(captured, []);
    assert.deepEqual(checked, ["web:alice:feature"]);
    busy = false;
    const response = await post("alice");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { memoryCount: number }).memoryCount, 2);
    assert.deepEqual(captured, ["feature-root", "worker-session"]);
    assert.deepEqual(checked.slice(1), ["web:alice:feature", "swarm:worker-thread"]);
    for (const scenario of ["revoked worker access", "worker in another scope", "worker thread mismatch"]) {
      await t.test(`feature memory GET and POST deny ${scenario}`, async () => {
        workerVisible = scenario !== "revoked worker access";
        workerScope = scenario === "worker in another scope" ? "personal:bob" : "personal:alice";
        workerThreadRef = scenario === "worker thread mismatch" ? "swarm:another-thread" : "swarm:worker-thread";
        assert.equal((await post("alice")).status, 403);
        const identity = await mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, portalSecret);
        const query = `?request=${++request}`;
        const read = await fetch(`${url}${query}`, {
          headers: signedRequestHeaders(secret, "GET", `${path}${query}`, "", { "x-portal-identity": identity }),
        });
        assert.equal(read.status, 403);
        assert.equal(inspections, 1);
        assert.deepEqual(captured, ["feature-root", "worker-session"]);
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
