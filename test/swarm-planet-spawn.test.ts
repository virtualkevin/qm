import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwarmService } from "../src/swarms/swarm-service.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function planetFixture(
  context: unknown = { group: "Tasks", ownership: "Task team", role: "Builder", task: "Build tasks", name: "Iris" },
) {
  const fixture = await swarmFixture();
  const forum = await fixture.sandboxes.create("alice", fixture.root.scopeId, "modal", "Shared project");
  const [parent] = await fixture.service.spawn(fixture.caller, {
    requestId: "initial",
    text: "Build the project",
    context,
    forumSandboxId: forum.id,
  });
  await fixture.service.sweep();
  const caller = await fixture.workerCaller(parent!.id);
  return { ...fixture, parent: parent!, worker: caller, forum };
}

test("delegated workers inherit their planet and shared project without inheriting agent identity", async () => {
  const f = await planetFixture();
  const contexts = [{ name: "Nova", role: "Reviewer", task: "Review tasks" }, {}];
  const workers = await f.service.spawn(f.worker, { requestId: "delegate", text: "Help with tasks", contexts });
  assert.deepEqual(
    workers.map((worker) => worker.context),
    contexts.map((context) => ({
      ownership: "Task team",
      ...context,
      group: "Tasks",
    })),
  );
  assert.ok(workers.every((worker) => worker.parentId === f.parent.id && worker.forumSandboxId === f.forum.id));
  assert.equal(new Set([f.parent.sandboxId, ...workers.map((worker) => worker.sandboxId)]).size, 3);
  await f.service.sweep();
  const layers = [{ scopeId: f.root.scopeId, mode: "rw" as const, mountPath: "/" }];
  const shared = await f.sandbox.provision(layers, { sandboxId: f.forum.id });
  await f.sandbox.writeFile(shared, "tasks.ts", "shared implementation");
  for (const worker of workers) {
    const project = await f.sandbox.provision(layers, { sandboxId: worker.forumSandboxId });
    assert.equal(await f.sandbox.readFile(project, "tasks.ts"), "shared implementation");
    const personal = await f.sandbox.provision(layers, { sandboxId: worker.sandboxId });
    assert.equal(await f.sandbox.readFile(personal, "tasks.ts"), null);
    assert.equal((await f.service.inspect(await f.workerCaller(worker.id))).self.state, "ready");
  }
});

test("explicit planet aliases create independent feature contexts while retaining the shared project", async () => {
  const f = await planetFixture();
  const contexts = [{ group: "Search", ownership: "Search team" }, { feature: "Sync" }, { featureId: "Auth" }];
  const workers = await f.service.spawn(f.worker, { requestId: "features", text: "Build related features", contexts });
  assert.deepEqual(
    workers.map((worker) => worker.context),
    contexts,
  );
  assert.ok(workers.every((worker) => worker.forumSandboxId === f.forum.id));
});

for (const alias of ["group", "feature", "featureId"]) {
  test(`delegation inherits the parent's ${alias} alias as a canonical planet group`, async () => {
    const f = await planetFixture({ [alias]: "Tasks", ownership: "Task team" });
    const [worker] = await f.service.spawn(f.worker, {
      requestId: "delegate",
      text: "Help",
      context: { group: " ", feature: 4, featureId: null, ownership: "Review team", extra: [1, 2] },
    });
    assert.deepEqual(worker!.context, {
      group: "Tasks",
      feature: 4,
      featureId: null,
      ownership: "Review team",
      extra: [1, 2],
    });
  });
}

test("arbitrary JSON contexts and parents without a planet retain their original values", async () => {
  const f = await planetFixture();
  const contexts = [null, false, 42, "Review tasks", [], ["Search", { group: "Other" }]];
  const workers = await f.service.spawn(f.worker, { requestId: "arbitrary", text: "Help", contexts });
  assert.deepEqual(
    workers.map((worker) => worker.context),
    contexts,
  );
  await f.service.context(f.worker, ["Tasks"]);
  const [worker] = await f.service.spawn(f.worker, {
    requestId: "unassigned",
    text: "Help",
    context: { role: "Reviewer" },
  });
  assert.deepEqual(worker!.context, { role: "Reviewer" });
});

test("an explicit forum replaces the inherited project after authorization", async () => {
  const f = await planetFixture();
  const forum = await f.sandboxes.create("alice", f.root.scopeId, "modal", "Other project");
  const [worker] = await f.service.spawn(f.worker, {
    requestId: "other-project",
    text: "Work in the other project",
    forumSandboxId: forum.id,
  });
  assert.equal(worker!.forumSandboxId, forum.id);
});

test("explicit and inherited forums reject unauthorized or mismatched scopes before reserving workers", async () => {
  const f = await planetFixture();
  const other = await f.sandboxes.create("bob", "personal:bob", "modal", "Private project");
  const before = await f.store.get(f.root.id);
  await assert.rejects(
    f.service.spawn(f.worker, {
      requestId: "unauthorized",
      text: "Help",
      forumSandboxId: other.id,
    }),
    /permission/,
  );
  const access = f.sandboxes.access.bind(f.sandboxes);
  f.sandboxes.access = async (actorId, id) => ({ ...(await access(actorId, id)), ownerScopeId: "personal:bob" });
  await assert.rejects(
    f.service.spawn(f.worker, {
      requestId: "mismatch",
      text: "Help",
      forumSandboxId: f.forum.id,
    }),
    /forum scope mismatch/,
  );
  await assert.rejects(f.service.spawn(f.worker, { requestId: "inherited", text: "Help" }), /forum scope mismatch/);
  assert.deepEqual(await f.store.get(f.root.id), before);
});

test("inherited forum access is rechecked before provisioning", async () => {
  const f = await planetFixture();
  const [worker] = await f.service.spawn(f.worker, { requestId: "delegate", text: "Help" });
  const access = f.sandboxes.access.bind(f.sandboxes);
  f.sandboxes.access = async (actorId, id) => {
    if (id === f.forum.id) throw new Error("forum access revoked");
    return access(actorId, id);
  };
  await f.service.sweep();
  const reserved = (await f.store.get(f.root.id))!.members.find((member) => member.id === worker!.id)!;
  assert.equal(reserved.state, "reserved");
  assert.match(reserved.error!, /forum access revoked/);
  assert.equal(await f.records.get(worker!.id), null);
  assert.equal(await f.sessions.getByThread(worker!.threadRef), null);
});

test("planet inheritance uses the parent context at the atomic reservation", async () => {
  const f = await planetFixture();
  const access = f.sandboxes.access.bind(f.sandboxes);
  f.sandboxes.access = async (actorId, id) => {
    await f.service.context(f.worker, { group: "Search", ownership: "Search team" });
    return access(actorId, id);
  };
  const [worker] = await f.service.spawn(f.worker, { requestId: "delegate", text: "Help" });
  assert.deepEqual(worker!.context, { group: "Search", ownership: "Search team" });
});

test("a changed inherited forum cannot bypass validation during reservation", async () => {
  const f = await planetFixture();
  const other = await f.sandboxes.create("bob", "personal:bob", "modal", "Private project");
  const access = f.sandboxes.access.bind(f.sandboxes);
  f.sandboxes.access = async (actorId, id) => {
    await f.store.update(f.root.id, (swarm) => {
      swarm.members.find((member) => member.id === f.parent.id)!.forumSandboxId = other.id;
    });
    return access(actorId, id);
  };
  await assert.rejects(f.service.spawn(f.worker, { requestId: "delegate", text: "Help" }), /parent forum changed/);
  assert.equal((await f.store.get(f.root.id))!.members.length, 2);
});

test("spawn retries preserve committed inheritance after parent context changes and lost acknowledgments", async () => {
  const f = await planetFixture();
  const update = f.store.update.bind(f.store);
  f.store.update = async (...args) => {
    await update(...args);
    throw new Error("lost acknowledgment");
  };
  const input = { requestId: "delegate", text: "Help", context: { role: "Reviewer" } };
  await assert.rejects(f.service.spawn(f.worker, input), /lost acknowledgment/);
  f.store.update = update;
  const committed = (await f.store.get(f.root.id))!.members.at(-1)!;
  await f.service.context(f.worker, { group: "Search", ownership: "Search team" });
  const restarted = createSwarmService(f.serviceOptions);
  const [worker] = await restarted.spawn(f.worker, input);
  assert.equal(worker!.id, committed.id);
  assert.deepEqual(worker!.context, { group: "Tasks", ownership: "Task team", role: "Reviewer" });
  assert.equal(worker!.forumSandboxId, f.forum.id);
  assert.equal((await f.store.get(f.root.id))!.members.length, 3);
  await assert.rejects(restarted.spawn(f.worker, { ...input, context: { group: "Search" } }), /reused/);
});

test("inherited planet metadata counts toward the context limit without partial reservations", async () => {
  const f = await swarmFixture();
  const [parent] = await f.service.spawn(f.caller, {
    requestId: "initial",
    text: "Work",
    context: { group: "A".repeat(100) },
    settings: { contextBytes: 128 },
  });
  await f.service.sweep();
  const caller = await f.workerCaller(parent!.id);
  const before = await f.store.get(f.root.id);
  await assert.rejects(
    f.service.spawn(caller, {
      requestId: "too-large",
      text: "Help",
      contexts: [{}, { role: "R".repeat(30) }],
    }),
    /invalid context/,
  );
  assert.deepEqual(await f.store.get(f.root.id), before);
});
