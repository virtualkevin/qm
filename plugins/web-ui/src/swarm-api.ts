import { api, mintSendKey, type RunPoll } from "./core-bridge";

export interface SwarmMember {
  id: string;
  sessionId?: string;
  sessionUrl?: string;
  threadRef: string;
  parentId?: string;
  depth: number;
  context: unknown;
  sandboxId?: string;
  forumSandboxId?: string;
  state: "reserved" | "ready" | "failed";
  attempts: number;
  cleanupPending?: boolean;
  error?: string;
}

export interface SwarmMessage {
  id: string;
  seq: number;
  senderId: string;
  senderSessionId: string;
  author: "agent" | "human";
  actorId: string;
  text: string;
  audience: string[];
  replyTo?: string;
  createdAt: number;
  notifications: Record<string, { state: "pending" | "queued" | "failed"; runId?: string }>;
}

export interface SwarmSettings {
  agents: number;
  depth: number;
  messages: number;
  notifications: number;
  spawnRequests: number;
  contextBytes: number;
  textBytes: number;
  waitMs: number;
  turnMs: number;
  lifetimeMs: number;
}

export interface SwarmInspection {
  id: string;
  self: SwarmMember;
  peers: SwarmMember[];
  backend: string;
  settings: SwarmSettings;
  expiresAt: number;
}

export interface SwarmSendInput {
  requestId?: string;
  audience: string[] | "all";
  text: string;
  replyTo?: string;
  notify?: boolean;
}

export interface SwarmSpawnInput {
  requestId?: string;
  runId?: string;
  text: string;
  count?: number;
  context?: unknown;
  contexts?: unknown[];
  settings?: Partial<SwarmSettings>;
  backend?: string;
  forumSandboxId?: string;
}

function swarmPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/swarm`;
}

export function inspectSwarm(sessionId: string, signal?: AbortSignal): Promise<SwarmInspection> {
  return api<SwarmInspection>(swarmPath(sessionId), { signal });
}

export async function readSwarmMessages(
  sessionId: string,
  options: { after?: number; replyTo?: string; waitMs?: number; signal?: AbortSignal } = {},
): Promise<SwarmMessage[]> {
  const query = new URLSearchParams({
    read: "1",
    after: String(options.after ?? 0),
    waitMs: String(options.waitMs ?? 0),
  });
  if (options.replyTo !== undefined) query.set("replyTo", options.replyTo);
  const result = await api<{ messages: SwarmMessage[] }>(`${swarmPath(sessionId)}?${query}`, {
    signal: options.signal,
  });
  return result.messages;
}

export async function sendSwarmMessage(sessionId: string, input: SwarmSendInput): Promise<SwarmMessage> {
  const result = await api<{ message: SwarmMessage }>(swarmPath(sessionId), {
    method: "POST",
    body: JSON.stringify({ ...input, requestId: input.requestId ?? mintSendKey(), action: "send" }),
  });
  return result.message;
}

export async function spawnSwarmMembers(sessionId: string, input: SwarmSpawnInput): Promise<SwarmMember[]> {
  const result = await api<{ members: SwarmMember[] }>(swarmPath(sessionId), {
    method: "POST",
    body: JSON.stringify({ ...input, requestId: input.requestId ?? mintSendKey(), action: "spawn" }),
  });
  return result.members;
}

export function renewSwarm(sessionId: string): Promise<{ expiresAt: number }> {
  return api<{ expiresAt: number }>(swarmPath(sessionId), {
    method: "POST",
    body: JSON.stringify({ action: "renew" }),
  });
}

export interface SwarmMemories {
  memoryCount: number;
  memoryCountsBySession: Record<string, number>;
  memories: Array<{
    id: string;
    text: string;
    source: "Memorable";
    sessionId: string;
    createdAt?: string;
    steps: number;
  }>;
  memoryStatus: "active" | "empty" | "unconfigured" | "unavailable";
  message?: string;
}

export function readSwarmMemories(sessionId: string, signal?: AbortSignal): Promise<SwarmMemories> {
  return api<SwarmMemories>(`${swarmPath(sessionId)}/memories`, { signal });
}

export function captureSwarmMemories(sessionId: string, signal?: AbortSignal): Promise<SwarmMemories> {
  return api<SwarmMemories>(`${swarmPath(sessionId)}/memories`, {
    method: "POST",
    body: "{}",
    signal,
  });
}

export async function summarizeSwarmMembers(
  sessionId: string,
  memberIds: string[],
  options: { signal?: AbortSignal; onRunStarted?: (runId: string) => void } = {},
): Promise<{ runId: string; summary: string }> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
    : AbortSignal.timeout(180_000);
  const started = await api<{ runId?: string; reply?: string; reason?: string }>(`${swarmPath(sessionId)}/summary`, {
    method: "POST",
    body: JSON.stringify({ memberIds, requestId: mintSendKey() }),
    signal,
  });
  const runId = started.runId;
  if (!runId) throw new Error(started.reason || "The summary run could not be started.");
  options.onRunStarted?.(runId);
  for (;;) {
    signal.throwIfAborted();
    const run = await api<RunPoll>(`/api/runs/${encodeURIComponent(runId)}`, { signal });
    if (run.status === "failed" || (run.status === "done" && run.result?.status !== "ok"))
      throw new Error(run.result?.reason || "The agent summary could not be generated.");
    if (run.status === "done") {
      const summary = run.result?.reply?.trim();
      if (!summary) throw new Error("The model returned an empty summary. Try refreshing.");
      return { runId, summary };
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, 700);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
