import type { PgPool } from "../../persistence/pg-pool.ts";

export interface MemorableMemory {
  id: string;
  text: string;
  source: "Memorable";
  sessionId: string;
  createdAt?: string;
  steps: number;
}

export interface MemorableInspection {
  memoryCount: number;
  memoryCountsBySession: Record<string, number>;
  memories: MemorableMemory[];
  memoryStatus: "active" | "empty" | "unconfigured" | "unavailable";
  message?: string;
}

export interface MemorableInspector {
  inspect(scopeId: string, sessionIds: string[]): Promise<MemorableInspection>;
}

export function createMemorableInspector(pool: Pick<PgPool, "q">): MemorableInspector {
  return {
    async inspect(scopeId, sessionIds) {
      const tables = await pool.q("SELECT to_regclass('memorable_procedures') AS procedures");
      if (!tables[0]?.procedures)
        return {
          memoryCount: 0,
          memoryCountsBySession: {},
          memories: [],
          memoryStatus: "unconfigured",
          message: "Connect Memorable to QM Postgres to record feature memories.",
        };
      const params = [scopeId, [...new Set(sessionIds)]];
      const counts = await pool.q(
        `SELECT json->>'session_id' AS session_id, count(*) AS total
         FROM memorable_procedures
         WHERE json->>'scope_id' = $1 AND json->>'session_id' = ANY($2::text[])
         GROUP BY json->>'session_id'`,
        params,
      );
      const rows = await pool.q(
        `SELECT id, json
         FROM memorable_procedures
         WHERE json->>'scope_id' = $1 AND json->>'session_id' = ANY($2::text[])
         ORDER BY json->>'created_at' DESC, id
         LIMIT 100`,
        params,
      );
      const memories = rows.map((row): MemorableMemory => {
        const record = row.json as Record<string, unknown>;
        const payload = record.payload as { steps?: unknown[] } | undefined;
        return {
          id: String(row.id),
          text: typeof record.title === "string" ? record.title : "Stored procedure",
          source: "Memorable",
          sessionId: String(record.session_id),
          ...(typeof record.created_at === "string" ? { createdAt: record.created_at } : {}),
          steps: Array.isArray(payload?.steps) ? payload.steps.length : 0,
        };
      });
      const memoryCountsBySession = Object.fromEntries(
        counts.map((row) => [String(row.session_id), Number(row.total)]),
      );
      const memoryCount = Object.values(memoryCountsBySession).reduce((total, count) => total + count, 0);
      return { memoryCount, memoryCountsBySession, memories, memoryStatus: memoryCount > 0 ? "active" : "empty" };
    },
  };
}
