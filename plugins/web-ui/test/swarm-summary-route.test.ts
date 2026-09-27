import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { swarmSummaryMemberIds } from "../server/swarm-summary.ts";

const turns: Array<Record<string, unknown>> = [];
const reads: string[] = [];
const members = [
  { id: "owner", sessionId: "root", state: "ready", context: { role: "Coordinator" } },
  { id: "database", sessionId: "database-session", state: "ready", context: { role: "Storage" } },
  { id: "ordering", sessionId: "ordering-session", state: "ready", context: { role: "Reordering" } },
  { id: "reserved", state: "reserved", context: { role: "Pending worker" } },
];
let privateMember = false;
let longForum = false;
const core = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  const reply = (status: number, value: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.method === "POST" && url.pathname === "/v1/turns") {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    turns.push(JSON.parse(body) as Record<string, unknown>);
    return reply(202, { status: "queued", runId: "summary-run" });
  }
  reads.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/v1/sessions/root/swarm") {
    if (url.searchParams.get("read") === "1" && longForum) {
      const after = Number(url.searchParams.get("after") ?? 0);
      return reply(200, {
        messages: Array.from({ length: 40 }, (_, index) => ({
          seq: index + 1,
          senderId: "database",
          author: "agent",
          text: `Storage progress ${index + 1}`,
          audience: ["owner"],
          createdAt: index + 1,
        }))
          .filter((message) => message.seq > after)
          .slice(0, 32),
      });
    }
    if (url.searchParams.get("read") === "1")
      return reply(200, {
        messages: [
          { senderId: "database", author: "agent", text: "Migration verified", audience: ["owner"], createdAt: 10 },
          {
            senderId: "owner",
            author: "human",
            text: "Please test keyboard ordering",
            audience: ["ordering"],
            createdAt: 11,
          },
          { senderId: "unselected", author: "agent", text: "UNSELECTED_PRIVATE", audience: ["owner"], createdAt: 12 },
        ],
      });
    return reply(200, { self: members[0], peers: members });
  }
  const session = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
  if (session) {
    if (url.searchParams.get("viewer") !== "alice" || (privateMember && session === "ordering-session"))
      return reply(404, { error: "not_found" });
    return reply(200, {
      session: { id: session },
      entries: [
        { type: "thinking", payload: { text: "HIDDEN_REASONING" } },
        { type: "user", payload: { text: "HIDDEN_USER", hidden: true } },
        { type: "user", payload: { text: "OVERHEARD", overheard: true } },
        { type: "tool_result", payload: { text: "TOOL_SECRET" } },
        { type: "user", payload: { text: `Implement ${session}` }, createdAt: 1 },
        { type: "assistant", payload: { text: `Progress ${session}` }, createdAt: 2 },
      ],
    });
  }
  return reply(404, { error: "not_found" });
});
await new Promise<void>((resolve) => core.listen(0, resolve));
const secret = "swarm-summary-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice,bob";
const { handler } = await import("../server/index.ts");
const web = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => web.listen(0, resolve));
const base = `http://localhost:${(web.address() as AddressInfo).port}`;

function post(body: unknown, user = "alice"): Promise<Response> {
  return fetch(`${base}/api/sessions/root/swarm/summary`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${user}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, secret),
    },
    body: JSON.stringify(body),
  });
}

after(async () => {
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await new Promise<void>((resolve) => core.close(() => resolve()));
});

test("summary validates bounded member IDs", () => {
  for (const invalid of [
    undefined,
    [],
    "owner",
    [null],
    [""],
    ["x".repeat(201)],
    Array.from({ length: 17 }, () => "a"),
  ])
    assert.equal(swarmSummaryMemberIds(invalid), null);
  assert.deepEqual(swarmSummaryMemberIds(["database", "database", "ordering"]), ["database", "ordering"]);
});

test("summary requires authentication and root session access", async () => {
  const before = turns.length;
  assert.equal((await fetch(`${base}/api/sessions/root/swarm/summary`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post({ memberIds: ["database"] }, "bob")).status, 404);
  assert.equal(turns.length, before);
});

test("summary rejects invalid input, foreign members, and inaccessible member transcripts before model work", async () => {
  const before = turns.length;
  for (const body of [
    {},
    { memberIds: [] },
    { memberIds: ["foreign"] },
    { memberIds: ["database"], requestId: "bad/id" },
  ])
    assert.equal((await post(body)).status, 400);
  privateMember = true;
  try {
    assert.equal((await post({ memberIds: ["database", "ordering"] })).status, 404);
  } finally {
    privateMember = false;
  }
  assert.equal(turns.length, before);
});

test("summary queues one durable fast model run with recent evidence from each selected agent", async () => {
  const response = await post({ memberIds: ["database", "ordering"], requestId: "selected-workers" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "queued", runId: "summary-run" });
  const turn = turns.at(-1)!;
  assert.deepEqual(turn.actor, { externalId: "alice" });
  assert.equal(turn.fastMode, true);
  assert.equal(turn.readOnly, true);
  assert.equal(turn.skipMemory, true);
  assert.equal(turn.surfaceTools, false);
  assert.equal(turn.idempotencyKey, "web:alice:swarm-summary.selected-workers");
  assert.deepEqual(turn.conversation, { kind: "dm", threadRef: "web:alice:swarm-summary:root:selected-workers" });
  const prompt = String(turn.text);
  for (const expected of [
    "Implement database-session",
    "Progress database-session",
    "Implement ordering-session",
    "Progress ordering-session",
    "Migration verified",
    "Please test keyboard ordering",
  ])
    assert.ok(prompt.includes(expected), expected);
  for (const excluded of ["HIDDEN_REASONING", "HIDDEN_USER", "OVERHEARD", "TOOL_SECRET", "UNSELECTED_PRIVATE"])
    assert.ok(!prompt.includes(excluded), excluded);
  assert.ok(reads.some((path) => path.startsWith("/v1/sessions/database-session?viewer=alice&tailTurns=4")));
  assert.ok(reads.some((path) => path.startsWith("/v1/sessions/ordering-session?viewer=alice&tailTurns=4")));
});

test("reserved agents remain in the evidence with no fabricated messages", async () => {
  assert.equal((await post({ memberIds: ["reserved"] })).status, 202);
  const prompt = String(turns.at(-1)!.text);
  assert.ok(prompt.includes('"memberId":"reserved"'));
  assert.ok(prompt.includes('"recentMessages":[]'));
});

test("summary paginates forum history to include the latest messages instead of the first page", async () => {
  longForum = true;
  try {
    assert.equal((await post({ memberIds: ["database"] })).status, 202);
    const prompt = String(turns.at(-1)!.text);
    assert.ok(prompt.includes("Storage progress 40"));
    assert.ok(!prompt.includes('Storage progress 1"'));
    assert.ok(reads.some((path) => path.includes("read=1&after=32")));
  } finally {
    longForum = false;
  }
});
