import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

test("development server serves the transformed swarm presentation entry", { timeout: 20000 }, async () => {
  const core = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      WEB_UI_DEV: "1",
      CORE_API_URL: `http://127.0.0.1:${(core.address() as AddressInfo).port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += String(data)));
  child.stderr.on("data", (data) => (output += String(data)));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
      const onData = () => {
        if (!output.includes("[web-ui] surface on")) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      };
      child.stdout.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${output}`));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/swarm.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /id="swarm-demo"/);
    assert.match(html, /\/src\/swarm-demo\.ts/);
    assert.match(html, /@vite\/client/);
    const source = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/swarm`);
    assert.equal(source.status, 401);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    }
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});
