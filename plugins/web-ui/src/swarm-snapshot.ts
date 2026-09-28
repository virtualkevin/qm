import {
  inspectSwarm,
  readSwarmMessages,
  readSwarmMemories,
  captureSwarmMemories,
  type SwarmMessage,
} from "./swarm-api";
import { swarmSnapshot } from "./swarm-data";
import type { SwarmSnapshot } from "./swarm-view";
import { api, type CoreSession } from "./core-bridge";

export function createSwarmSnapshotLoader(sessionId: string, signal?: AbortSignal): () => Promise<SwarmSnapshot> {
  const messages = new Map<number, SwarmMessage>();
  let after = 0;
  let pending: Promise<SwarmSnapshot> | undefined;
  let capturedActivity = "";
  let capturing = false;
  let nextCaptureAt = 0;
  return () => {
    pending ??= (async () => {
      const [inspection, sessionData, storedMemory] = await Promise.all([
        inspectSwarm(sessionId, signal),
        api<{ sessions: CoreSession[] }>("/api/sessions", { signal }),
        readSwarmMemories(sessionId, signal).catch(() => ({
          memoryCount: 0,
          memoryCountsBySession: {} as Record<string, number>,
          memories: [],
          memoryStatus: "unavailable" as const,
        })),
      ]);
      const memory = storedMemory;
      const workerSessions = sessionData.sessions.filter((session) =>
        inspection.peers.some((peer) => peer.sessionId === session.id),
      );
      const activity = workerSessions
        .map((session) => `${session.id}:${session.lastActivityAt ?? 0}`)
        .sort()
        .join("|");
      if (
        !capturing &&
        Date.now() >= nextCaptureAt &&
        inspection.peers.length > 1 &&
        inspection.peers.every((peer) => peer.state === "ready") &&
        workerSessions.every((session) => !session.working) &&
        activity !== capturedActivity
      ) {
        capturing = true;
        void captureSwarmMemories(sessionId)
          .then(() => {
            capturedActivity = activity;
          })
          .catch(() => {
            nextCaptureAt = Date.now() + 30_000;
          })
          .finally(() => {
            capturing = false;
          });
      }
      for (;;) {
        const page = await readSwarmMessages(sessionId, { after, signal });
        for (const message of page) {
          messages.set(message.seq, message);
          after = Math.max(after, message.seq);
        }
        if (page.length < 32) break;
      }
      const snapshot = swarmSnapshot(
        inspection,
        [...messages.values()].sort((a, b) => a.seq - b.seq),
        sessionData.sessions,
      );
      for (const feature of snapshot.features) {
        const sessionIds = new Set(
          snapshot.agents.filter((agent) => agent.featureId === feature.id).map((agent) => agent.sessionId),
        );
        feature.memories = memory.memories.filter((item) => sessionIds.has(item.sessionId));
        feature.memoryCount = ["unavailable", "unconfigured"].includes(memory.memoryStatus)
          ? undefined
          : [...sessionIds].reduce((count, id) => count + (id ? (memory.memoryCountsBySession[id] ?? 0) : 0), 0);
        feature.memoryStatus = memory.memoryStatus === "active" && !feature.memoryCount ? "empty" : memory.memoryStatus;
      }
      return snapshot;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

export function loadSwarmSnapshot(sessionId: string, signal?: AbortSignal): Promise<SwarmSnapshot> {
  return createSwarmSnapshotLoader(sessionId, signal)();
}
