#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = join(root, "deploy/local");
const checkpoints = join(local, "checkpoints");
const postgres = "qm-local-postgres-1";
const archiveImage = "postgres:18";
const envFiles = ["local.env", "todo.env"];
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function command(program, args, { inputFile, outputFile } = {}) {
  const input = inputFile ? openSync(inputFile, "r") : undefined;
  const output = outputFile ? openSync(outputFile, "wx", 0o600) : undefined;
  try {
    const result = spawnSync(program, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: [input ?? "ignore", output ?? "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${program} ${args[0]} failed; no command output is shown because it may contain private data.`);
    }
    return result.stdout?.trim() ?? "";
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

const docker = (args, options) => command("docker", args, options);
const sql = (query, database = "qm") =>
  docker(["exec", postgres, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "qm", "-d", database, "-Atqc", query]);

function assertIdle() {
  if (sql("SELECT count(*) FROM runs WHERE status IN ('pending', 'running')") !== "0") {
    throw new Error("Wait for all queued and running agents to finish before saving or restoring a checkpoint.");
  }
}

function inventory() {
  const ids = new Set();
  for (const label of ["com.docker.compose.project=qm-local", "com.docker.compose.project=qm-todo", "qm.org=local"]) {
    for (const id of docker(["ps", "-aq", "--filter", `label=${label}`])
      .split(/\s+/)
      .filter(Boolean))
      ids.add(id);
  }
  if (!ids.size) throw new Error("Start the local Docker demo before using checkpoints.");
  const containers = JSON.parse(docker(["inspect", ...ids]));
  const core = containers.find((container) => container.Name === "/qm-local-core");
  const database = containers.find((container) => container.Name === `/${postgres}`);
  const coreVolume = core?.Mounts.find((mount) => mount.Type === "volume" && mount.Destination === "/data")?.Name;
  if (coreVolume !== "qm-local_core-data" || !database?.State.Running) {
    throw new Error("Expected the qm-local core-data volume and a running local Postgres container.");
  }
  const volumes = new Set([coreVolume]);
  const selected = containers.filter((container) => {
    const labels = container.Config.Labels ?? {};
    return (
      labels["qm.org"] === "local" ||
      (labels["com.docker.compose.project"] === "qm-local" &&
        ["core", "web", "portal"].includes(labels["com.docker.compose.service"])) ||
      (labels["com.docker.compose.project"] === "qm-todo" && labels["com.docker.compose.service"] === "todo")
    );
  });
  for (const container of selected) {
    for (const mount of container.Mounts) {
      if (mount.Type === "volume" && mount.Name.startsWith("qm-home-")) volumes.add(mount.Name);
    }
  }
  for (const name of envFiles) {
    const path = join(local, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing local config: ${name}`);
  }
  const todoVolume = readFileSync(join(local, "todo.env"), "utf8").match(
    /^TODO_WORKSPACE_VOLUME=([A-Za-z0-9_.-]+)$/m,
  )?.[1];
  if (!todoVolume?.startsWith("qm-home-")) throw new Error("todo.env must identify the shared qm-home sandbox volume.");
  volumes.add(todoVolume);
  docker(["volume", "inspect", ...volumes]);
  return { containers: selected, volumes: [...volumes].sort() };
}

function stopDemo(state) {
  assertIdle();
  state.running = state.containers.filter((container) => container.State.Running);
  if (state.running.length) docker(["stop", "--time", "10", ...state.running.map((container) => container.Id)]);
  assertIdle();
}

function startDemo(state, restored = false) {
  const running = state.running ?? [];
  if (!restored) {
    if (running.length) docker(["start", ...running.map((container) => container.Id)]);
    return;
  }
  const services = running
    .filter((container) => container.Config.Labels?.["com.docker.compose.project"] === "qm-local")
    .map((container) => container.Config.Labels["com.docker.compose.service"]);
  if (services.length)
    docker(["compose", "-f", "deploy/local/compose.yaml", "up", "-d", "--no-deps", "--force-recreate", ...services]);
  if (running.some((container) => container.Config.Labels?.["com.docker.compose.project"] === "qm-todo")) {
    docker([
      "compose",
      "--env-file",
      "deploy/local/todo.env",
      "-f",
      "deploy/local/compose.todo.yaml",
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "todo",
    ]);
  }
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function checkpointPath(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(name ?? ""))
    throw new Error("Use a checkpoint name containing only letters, numbers, underscores, and hyphens.");
  return join(checkpoints, name);
}

async function save(name, state) {
  const destination = checkpointPath(name);
  if (existsSync(destination)) throw new Error(`Checkpoint already exists: ${name}`);
  const temporary = `${destination}.partial`;
  mkdirSync(temporary, { mode: 0o700 });
  const artifacts = [];
  const record = async (file, kind, volume) =>
    artifacts.push({ file, kind, ...(volume ? { volume } : {}), sha256: await digest(join(temporary, file)) });
  docker(["exec", postgres, "pg_dump", "-U", "qm", "-d", "qm", "--format=custom", "--no-owner", "--no-acl"], {
    outputFile: join(temporary, "database.dump"),
  });
  await record("database.dump", "database");
  for (const volume of state.volumes) {
    const file = `${volume}.tar.gz`;
    docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=volume,src=${volume},dst=/volume,readonly`,
        archiveImage,
        "tar",
        "-czf",
        "-",
        "-C",
        "/volume",
        ".",
      ],
      { outputFile: join(temporary, file) },
    );
    await record(file, "volume", volume);
  }
  for (const file of envFiles) {
    copyFileSync(join(local, file), join(temporary, file));
    chmodSync(join(temporary, file), 0o600);
    await record(file, "config");
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    commit: command("git", ["rev-parse", "HEAD"]),
    artifacts,
  };
  writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, destination);
  return destination;
}

async function validate(name) {
  const directory = checkpointPath(name);
  if (!lstatSync(directory).isDirectory()) throw new Error("Checkpoint must be a local directory.");
  const manifestPath = join(directory, "manifest.json");
  if (!lstatSync(manifestPath).isFile()) throw new Error("Checkpoint manifest must be a regular file.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.artifacts) || !/^[0-9a-f]{40}$/.test(manifest.commit))
    throw new Error("Invalid checkpoint manifest.");
  const files = new Set();
  for (const artifact of manifest.artifacts) {
    const valid =
      (artifact.kind === "database" && artifact.file === "database.dump") ||
      (artifact.kind === "config" && envFiles.includes(artifact.file)) ||
      (artifact.kind === "volume" &&
        /^(qm-local_core-data|qm-home-[A-Za-z0-9_-]+)$/.test(artifact.volume) &&
        artifact.file === `${artifact.volume}.tar.gz`);
    if (!valid || files.has(artifact.file) || !/^[0-9a-f]{64}$/.test(artifact.sha256))
      throw new Error("Invalid checkpoint artifact metadata.");
    files.add(artifact.file);
    const path = join(directory, artifact.file);
    if (!lstatSync(path).isFile() || (await digest(path)) !== artifact.sha256)
      throw new Error(`Checkpoint integrity check failed: ${artifact.file}`);
  }
  for (const required of ["database.dump", "qm-local_core-data.tar.gz", ...envFiles]) {
    if (!files.has(required)) throw new Error(`Incomplete checkpoint: ${required}`);
  }
  const todoVolume = readFileSync(join(directory, "todo.env"), "utf8").match(
    /^TODO_WORKSPACE_VOLUME=([A-Za-z0-9_.-]+)$/m,
  )?.[1];
  if (!todoVolume || !files.has(`${todoVolume}.tar.gz`))
    throw new Error("The checkpoint is missing its todo workspace volume.");
  docker(["exec", "-i", postgres, "pg_restore", "--list"], { inputFile: join(directory, "database.dump") });
  for (const artifact of manifest.artifacts.filter((entry) => entry.kind === "volume")) {
    const entries = docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,src=${directory},dst=/checkpoint,readonly`,
      archiveImage,
      "tar",
      "-tzf",
      `/checkpoint/${artifact.file}`,
    ]);
    if (entries.split("\n").some((entry) => entry.startsWith("/") || entry.split("/").includes("..")))
      throw new Error("Unsafe path in checkpoint archive.");
  }
  return { directory, manifest };
}

function restore(snapshot) {
  const suffix = `${Date.now()}_${process.pid}`;
  const staged = `qm_demo_restore_${suffix}`;
  const previous = `qm_demo_before_${suffix}`;
  sql(`CREATE DATABASE ${staged} OWNER qm`, "postgres");
  docker(
    ["exec", "-i", postgres, "pg_restore", "-U", "qm", "-d", staged, "--exit-on-error", "--no-owner", "--no-acl"],
    { inputFile: join(snapshot.directory, "database.dump") },
  );
  for (const artifact of snapshot.manifest.artifacts.filter((entry) => entry.kind === "volume")) {
    docker(["volume", "create", artifact.volume]);
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=volume,src=${artifact.volume},dst=/volume`,
      "--mount",
      `type=bind,src=${snapshot.directory},dst=/checkpoint,readonly`,
      archiveImage,
      "sh",
      "-ec",
      'find /volume -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "$1" -C /volume',
      "restore",
      `/checkpoint/${artifact.file}`,
    ]);
  }
  for (const file of envFiles) {
    copyFileSync(join(snapshot.directory, file), join(local, file));
    chmodSync(join(local, file), 0o600);
  }
  sql(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'qm' AND pid <> pg_backend_pid()",
    "postgres",
  );
  sql(`ALTER DATABASE qm RENAME TO ${previous}`, "postgres");
  try {
    sql(`ALTER DATABASE ${staged} RENAME TO qm`, "postgres");
  } catch (error) {
    sql(`ALTER DATABASE ${previous} RENAME TO qm`, "postgres");
    throw error;
  }
  console.log(`Previous database retained locally as ${previous}.`);
}

async function main() {
  const [action, suppliedName, ...extra] = process.argv.slice(2);
  if (!["save", "verify", "restore"].includes(action) || extra.length || (action !== "save" && !suppliedName)) {
    console.log("Usage: node scripts/demo-checkpoint.mjs save [name] | verify <name> | restore <name>");
    process.exitCode = 1;
    return;
  }
  const name = suppliedName ?? `demo-${timestamp()}`;
  checkpointPath(name);
  process.umask(0o077);
  mkdirSync(checkpoints, { recursive: true, mode: 0o700 });
  chmodSync(checkpoints, 0o700);
  const lock = join(checkpoints, ".lock");
  mkdirSync(lock, { mode: 0o700 });
  let state;
  let restart = true;
  let restored = false;
  try {
    const snapshot = action === "save" ? undefined : await validate(name);
    if (action === "verify") {
      console.log(`Verified checkpoint ${name}: ${snapshot.manifest.artifacts.length} artifacts.`);
      return;
    }
    if (action === "save" && existsSync(checkpointPath(name))) throw new Error(`Checkpoint already exists: ${name}`);
    state = inventory();
    stopDemo(state);
    if (action === "save") {
      await save(name, state);
      console.log(`Saved local checkpoint ${name}.`);
    } else {
      const backup = `before-restore-${timestamp()}`;
      await save(backup, state);
      console.log(`Current state saved as ${backup}.`);
      restart = false;
      restore(snapshot);
      restored = true;
      restart = true;
      console.log(`Restored checkpoint ${name}.`);
    }
  } finally {
    try {
      if (state && restart) startDemo(state, restored);
      if (state && !restart)
        console.error(
          "Restore did not finish. Demo services remain stopped; restore the before-restore checkpoint to recover.",
        );
    } finally {
      rmdirSync(lock);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
