import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function completeRuns(fixture: Awaited<ReturnType<typeof swarmFixture>>): Promise<void> {
  for (const existing of await fixture.runs.list()) {
    const run = existing.status === "pending" ? await fixture.runs.claimById(existing.id, "finish", 60_000) : existing;
    if (run?.status === "running")
      assert.ok(await fixture.runs.complete(run.id, run.leaseToken!, { status: "ok", reply: "Done" }));
  }
}

test("only authorized humans can renew an expired swarm", async () => {
  const fixture = await swarmFixture();
  await fixture.service.spawn(fixture.caller, { requestId: "initial", text: "Work" });
  await assert.rejects(fixture.service.renew(fixture.caller), /only a human/);
  await assert.rejects(
    fixture.service.renew({ kind: "human", actorId: "bob", sessionId: fixture.root.id }),
    /session access denied/,
  );
});

test("renewal preserves feature ownership and history and never resets a live window budget", async () => {
  const fixture = await swarmFixture();
  await fixture.service.spawn(fixture.caller, {
    requestId: "initial",
    text: "Implement list reordering",
    context: { feature: "ordering", role: "maintainer" },
  });
  await fixture.service.sweep();
  await completeRuns(fixture);
  const human = { kind: "human" as const, actorId: "alice", sessionId: fixture.root.id };
  await fixture.store.update(fixture.root.id, (swarm) => {
    swarm.expiresAt = 1;
    swarm.notificationCount = swarm.settings.notifications;
  });
  const before = (await fixture.store.get(fixture.root.id))!;
  const start = Date.now();
  const [first, second] = await Promise.all([fixture.service.renew(human), fixture.service.renew(human)]);
  assert.equal(first.expiresAt, second.expiresAt);
  assert.ok(first.expiresAt >= start + before.settings.lifetimeMs);
  assert.ok(first.expiresAt <= Date.now() + before.settings.lifetimeMs);
  const after = (await fixture.store.get(fixture.root.id))!;
  assert.deepEqual(after.members, before.members);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.spawnRequests, before.spawnRequests);
  assert.equal(after.notificationCount, 0);
  await fixture.service.send(human, { requestId: "bug", audience: "all", text: "Fix a list reordering regression" });
  const sent = (await fixture.store.get(fixture.root.id))!;
  assert.ok(sent.notificationCount > 0);
  assert.equal((await fixture.service.renew(human)).expiresAt, first.expiresAt);
  assert.equal((await fixture.store.get(fixture.root.id))!.notificationCount, sent.notificationCount);
});

test("renewal cannot revive pending deliveries or currently running agent capabilities", async () => {
  const fixture = await swarmFixture();
  await fixture.service.spawn(fixture.caller, { requestId: "initial", text: "Work" });
  const human = { kind: "human" as const, actorId: "alice", sessionId: fixture.root.id };
  await fixture.store.update(fixture.root.id, (swarm) => {
    swarm.expiresAt = 1;
  });
  await assert.rejects(fixture.service.renew(human), /pending work/);
  await fixture.service.sweep();
  await assert.rejects(fixture.service.renew(human), /active runs/);
  assert.equal((await fixture.store.get(fixture.root.id))!.expiresAt, 1);
  await completeRuns(fixture);
  assert.ok((await fixture.service.renew(human)).expiresAt > Date.now());
});
