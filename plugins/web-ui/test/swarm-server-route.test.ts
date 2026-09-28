import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";

const secret = "swarm-web-route-test";
const calls: Array<{ method: string; url: URL; body: unknown; identity: string; signatureValid: boolean }> = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const url = new URL(path, "http://core");
    const body = raw ? JSON.parse(raw) : null;
    calls.push({
      method,
      url,
      body,
      identity: String(req.headers[PORTAL_IDENTITY_HEADER] ?? ""),
      signatureValid:
        req.headers["x-signature"] ===
        signRequest(secret, Number(req.headers["x-timestamp"]), canonicalPayload(method, path, raw)),
    });
    res.setHeader("content-type", "application/json");
    if (url.pathname.includes("/hidden/")) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: "session access denied" }));
    }
    if (body && "actorId" in body) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "unsupported swarm request field" }));
    }
    if (method === "POST") {
      res.writeHead(202);
      return res.end(JSON.stringify({ message: { id: "message-1", seq: 1 } }));
    }
    res.end(JSON.stringify(url.searchParams.get("read") === "1" ? { messages: [] } : { id: "swarm-1" }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret);
const headers = { [PORTAL_IDENTITY_HEADER]: token, "content-type": "application/json" };

test.after(() => {
  surface.close();
  core.close();
});

test("swarm reads preserve signed identity and only forward swarm read parameters", async () => {
  const response = await fetch(
    `${base}/api/sessions/session-1/swarm?read=1&after=7&waitMs=20&replyTo=message%26one&viewer=mallory`,
    { headers },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { messages: [] });
  const call = calls.at(-1)!;
  assert.equal(call.url.pathname, "/v1/sessions/session-1/swarm");
  assert.equal(call.identity, token);
  assert.equal(call.signatureValid, true);
  assert.equal(call.url.searchParams.get("read"), "1");
  assert.equal(call.url.searchParams.get("after"), "7");
  assert.equal(call.url.searchParams.get("waitMs"), "20");
  assert.equal(call.url.searchParams.get("replyTo"), "message&one");
  assert.equal(call.url.searchParams.has("viewer"), false);
});

test("swarm inspection and writes relay the core status and payload", async () => {
  const inspection = await fetch(`${base}/api/sessions/session-1/swarm`, { headers });
  assert.deepEqual(await inspection.json(), { id: "swarm-1" });
  const body = { action: "send", requestId: "gesture-1", audience: ["worker-1"], text: "Check the layout" };
  const sent = await fetch(`${base}/api/sessions/session-1/swarm`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(sent.status, 202);
  assert.deepEqual(await sent.json(), { message: { id: "message-1", seq: 1 } });
  assert.deepEqual(calls.at(-1)!.body, body);
  assert.equal(calls.at(-1)!.identity, token);
  assert.equal(calls.at(-1)!.signatureValid, true);
});

test("core authorization and actor-injection rejections remain visible", async () => {
  const denied = await fetch(`${base}/api/sessions/hidden/swarm`, { headers });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "session access denied" });
  const injected = await fetch(`${base}/api/sessions/session-1/swarm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "send", actorId: "mallory", text: "hello" }),
  });
  assert.equal(injected.status, 400);
  assert.deepEqual(await injected.json(), { error: "unsupported swarm request field" });
});

test("missing authentication and malformed request bodies never reach core", async () => {
  const before = calls.length;
  const unsigned = await fetch(`${base}/api/sessions/session-1/swarm`);
  assert.equal(unsigned.status, 401);
  const invalid = await fetch(`${base}/api/sessions/session-1/swarm`, { method: "POST", headers, body: "{" });
  assert.equal(invalid.status, 400);
  const empty = await fetch(`${base}/api/sessions/session-1/swarm`, { method: "POST", headers });
  assert.equal(empty.status, 400);
  assert.equal(calls.length, before);
});
