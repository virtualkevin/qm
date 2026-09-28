import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(t: { after: (fn: () => void) => void }, options: { busy?: boolean; failArchive?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "qm-checkpoint-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = join(directory, "deploy/local");
  const scripts = join(directory, "scripts");
  const bin = join(directory, "bin");
  for (const path of [local, scripts, bin]) mkdirSync(path, { recursive: true });
  copyFileSync(new URL("../scripts/demo-checkpoint.mjs", import.meta.url), join(scripts, "demo-checkpoint.mjs"));
  writeFileSync(join(local, "local.env"), "CORE_SIGNING_SECRET=test-only\n");
  writeFileSync(join(local, "todo.env"), "TODO_WORKSPACE_VOLUME=qm-home-sharedtodo\n");
  const containers = [
    { Id: "postgres", Name: "/qm-local-postgres-1", State: { Running: true }, Config: { Labels: {} }, Mounts: [] },
    {
      Id: "core",
      Name: "/qm-local-core",
      State: { Running: true },
      Config: { Labels: { "com.docker.compose.project": "qm-local", "com.docker.compose.service": "core" } },
      Mounts: [{ Type: "volume", Name: "qm-local_core-data", Destination: "/data" }],
    },
    {
      Id: "sandbox",
      Name: "/sandbox",
      State: { Running: true },
      Config: { Labels: { "qm.org": "local" } },
      Mounts: [{ Type: "volume", Name: "qm-home-sharedtodo", Destination: "/root" }],
    },
    {
      Id: "stopped-sandbox",
      Name: "/stopped-sandbox",
      State: { Running: false },
      Config: { Labels: { "qm.org": "local" } },
      Mounts: [{ Type: "volume", Name: "qm-home-retained", Destination: "/root" }],
    },
  ];
  const log = join(directory, "commands.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "ps") console.log("core postgres sandbox stopped-sandbox");
else if (args[0] === "inspect") console.log(JSON.stringify(${JSON.stringify(containers)}));
else if (args.includes("SELECT count(*) FROM runs WHERE status IN ('pending', 'running')")) console.log(${Number(Boolean(options.busy))});
else if (args.includes("pg_dump")) process.stdout.write("private database fixture");
else if (args.includes("-czf")) {
  if (${Boolean(options.failArchive)}) process.exit(1);
  process.stdout.write("private volume fixture");
}
else if (args.includes("-tzf")) console.log("./\\n./workspace/todo-app/server.mjs");
`,
    { mode: 0o700 },
  );
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconsole.log("${"a".repeat(40)}");\n`, { mode: 0o700 });
  return {
    local,
    commands: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    run: (...args: string[]) =>
      spawnSync(process.execPath, [join(scripts, "demo-checkpoint.mjs"), ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
  };
}

test("checkpoint refuses queued or running agents before stopping any containers", (t) => {
  const setup = fixture(t, { busy: true });
  const result = setup.run("save", "baseline");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /queued and running agents/);
  assert.equal(
    setup.commands().some(([command]) => command === "stop" || command === "start"),
    false,
  );
});

test("failed checkpoint resumes only containers that were running", (t) => {
  const setup = fixture(t, { failArchive: true });
  const result = setup.run("save", "baseline");
  assert.equal(result.status, 1);
  assert.deepEqual(
    setup.commands().find(([command]) => command === "start"),
    ["start", "core", "sandbox"],
  );
  assert.doesNotMatch(result.stdout + result.stderr, /private database fixture|test-only/);
});

test("checkpoint captures stopped sandbox volumes and uses private file permissions", (t) => {
  const setup = fixture(t);
  const result = setup.run("save", "baseline");
  assert.equal(result.status, 0, result.stderr);
  const checkpoint = join(setup.local, "checkpoints/baseline");
  const manifest = JSON.parse(readFileSync(join(checkpoint, "manifest.json"), "utf8"));
  assert.equal(statSync(checkpoint).mode & 0o777, 0o700);
  assert.ok(manifest.artifacts.some((artifact: { volume?: string }) => artifact.volume === "qm-home-retained"));
  for (const artifact of manifest.artifacts)
    assert.equal(statSync(join(checkpoint, artifact.file)).mode & 0o777, 0o600);
  assert.equal(setup.run("verify", "baseline").status, 0);
});

test("restore rejects corrupted checkpoint data before stopping services", (t) => {
  const setup = fixture(t);
  assert.equal(setup.run("save", "baseline").status, 0);
  const commandCount = setup.commands().length;
  writeFileSync(join(setup.local, "checkpoints/baseline/database.dump"), "corrupt");
  const result = setup.run("restore", "baseline");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /integrity check failed/);
  assert.equal(setup.commands().length, commandCount);
});

test("restore rejects a checkpoint missing its shared todo workspace", (t) => {
  const setup = fixture(t);
  assert.equal(setup.run("save", "baseline").status, 0);
  const checkpoint = join(setup.local, "checkpoints/baseline");
  const manifest = JSON.parse(readFileSync(join(checkpoint, "manifest.json"), "utf8"));
  const changedEnv = "TODO_WORKSPACE_VOLUME=qm-home-missing\n";
  writeFileSync(join(checkpoint, "todo.env"), changedEnv);
  manifest.artifacts.find((artifact: { file: string }) => artifact.file === "todo.env").sha256 = createHash("sha256")
    .update(changedEnv)
    .digest("hex");
  writeFileSync(join(checkpoint, "manifest.json"), JSON.stringify(manifest));
  const commandCount = setup.commands().length;
  const result = setup.run("restore", "baseline");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing its todo workspace/);
  assert.equal(setup.commands().length, commandCount);
});

test("restore saves current state before mutation and leaves sandboxes stopped", (t) => {
  const setup = fixture(t);
  assert.equal(setup.run("save", "baseline").status, 0);
  const commandCount = setup.commands().length;
  const result = setup.run("restore", "baseline");
  assert.equal(result.status, 0, result.stderr);
  const commands = setup.commands().slice(commandCount);
  const dumpIndex = commands.findIndex((args) => args.includes("pg_dump"));
  const restoreIndex = commands.findIndex((args) => args.includes("--exit-on-error"));
  assert.ok(dumpIndex >= 0 && restoreIndex > dumpIndex);
  assert.equal(
    commands.some(([command]) => command === "start"),
    false,
  );
  assert.ok(commands.some(([command]) => command === "compose"));
  assert.match(result.stdout, /Current state saved as before-restore-/);
});
