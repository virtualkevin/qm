import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorableInspector } from "../src/memory/memorable/inspection.ts";
import type { PgPool } from "../src/persistence/pg-pool.ts";

test("Memorable inspection counts stored records and retains scope and feature provenance", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const inspector = createMemorableInspector({
    q: async (text, params) => {
      calls.push({ text, params });
      if (text.includes("to_regclass")) return [{ procedures: "memorable_procedures" }];
      if (text.includes("GROUP BY")) return [{ session_id: "worker-1", total: "107" }];
      return [
        {
          id: "personal:dev/reorder-1",
          total: "107",
          json: {
            title: "Persist reordered todo items",
            session_id: "worker-1",
            created_at: "2026-09-27T23:00:00.000Z",
            payload: { steps: [{ action: "execute" }, { action: "write" }] },
          },
        },
      ];
    },
  } satisfies Pick<PgPool, "q">);
  const result = await inspector.inspect("personal:dev", ["root", "worker-1", "root"]);
  assert.equal(result.memoryCount, 107);
  assert.deepEqual(result.memoryCountsBySession, { "worker-1": 107 });
  assert.equal(result.memoryStatus, "active");
  assert.equal(result.memories[0]?.steps, 2);
  assert.equal(result.memories[0]?.source, "Memorable");
  assert.deepEqual(calls[1]?.params, ["personal:dev", ["root", "worker-1"]]);
  assert.match(calls[1]?.text ?? "", /scope_id.*= \$1 AND json->>'session_id' = ANY\(\$2::text\[\]\)/);
});

test("Memorable inspection reports missing integration and empty real storage separately", async () => {
  const missing = createMemorableInspector({ q: async () => [{ procedures: null }] });
  assert.equal((await missing.inspect("personal:dev", ["root"])).memoryStatus, "unconfigured");
  const empty = createMemorableInspector({
    q: async (text) => (text.includes("to_regclass") ? [{ procedures: "memorable_procedures" }] : []),
  });
  assert.deepEqual(await empty.inspect("personal:dev", ["root"]), {
    memoryCount: 0,
    memoryCountsBySession: {},
    memories: [],
    memoryStatus: "empty",
  });
});

test("Memorable inspection propagates database errors instead of inventing an empty result", async () => {
  const inspector = createMemorableInspector({
    q: async () => {
      throw new Error("database offline");
    },
  });
  await assert.rejects(inspector.inspect("personal:dev", ["root"]), /database offline/);
});
