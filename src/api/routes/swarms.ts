import { sendJson } from "../http.ts";
import { errMessage } from "../../util/errors.ts";
import type { SwarmCaller } from "../../swarms/swarm-service.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function swarmRequest(ctx: ApiCtx): Promise<void> {
  const { app, res, body, capability, actor, params, method, url } = ctx;
  if (!app.swarms) return sendJson(res, 503, { error: "swarm service unavailable" });
  let caller: SwarmCaller;
  if (capability && !params.id) caller = { kind: "agent", claims: capability };
  else if (actor && params.id && !capability) {
    if (!(await app.getSessionForViewer(params.id, actor.p)))
      return sendJson(res, 403, { error: "session access denied" });
    caller = {
      kind: "human",
      actorId: actor.p,
      sessionId: params.id,
      ...(isObj(body) && typeof body.runId === "string" ? { runId: body.runId } : {}),
    };
  } else return sendJson(res, 403, { error: "session-bound authentication required" });
  try {
    if (method === "GET") {
      if (url.searchParams.get("read") === "1") {
        const messages = await app.swarms.read(caller, {
          after: Number(url.searchParams.get("after") ?? 0),
          waitMs: Number(url.searchParams.get("waitMs") ?? 0),
          ...(url.searchParams.has("replyTo") ? { replyTo: url.searchParams.get("replyTo")! } : {}),
        });
        return sendJson(res, 200, { messages });
      }
      return sendJson(res, 200, await app.swarms.inspect(caller));
    }
    if (!isObj(body)) throw new Error("expected an object");
    if (body.action === "renew") {
      if (caller.kind !== "human") throw new Error("only a human can renew a swarm work window");
      if (Object.keys(body).some((key) => key !== "action")) throw new Error("unsupported swarm request field");
      return sendJson(res, 200, await app.swarms.renew(caller));
    }
    const allowed = new Set([
      "action",
      ...(caller.kind === "human" ? ["runId"] : []),
      ...(body.action === "context" ? ["context"] : ["requestId", "text"]),
      ...(body.action === "spawn" ? ["count", "context", "contexts", "forumSandboxId"] : []),
      ...(body.action === "send" ? ["audience", "replyTo", "notify"] : []),
      ...(body.action === "spawn" ? ["settings", "backend"] : []),
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("unsupported swarm request field");
    if (body.action === "context") {
      if (!("context" in body)) throw new Error("context required");
      return sendJson(res, 200, await app.swarms.context(caller, body.context));
    }
    if (typeof body.requestId !== "string" || typeof body.text !== "string")
      throw new Error("requestId and text required");
    if (body.action === "spawn") {
      if (body.count !== undefined && typeof body.count !== "number") throw new Error("invalid count");
      if (body.contexts !== undefined && !Array.isArray(body.contexts)) throw new Error("invalid contexts");
      if (body.forumSandboxId !== undefined && typeof body.forumSandboxId !== "string")
        throw new Error("invalid forumSandboxId");
      if (body.settings !== undefined && !isObj(body.settings)) throw new Error("invalid settings");
      if (body.backend !== undefined && typeof body.backend !== "string") throw new Error("invalid backend");
      const members = await app.swarms.spawn(caller, {
        requestId: body.requestId,
        text: body.text,
        ...(typeof body.count === "number" ? { count: body.count } : {}),
        ...("context" in body ? { context: body.context } : {}),
        ...(Array.isArray(body.contexts) ? { contexts: body.contexts } : {}),
        ...(typeof body.forumSandboxId === "string" ? { forumSandboxId: body.forumSandboxId } : {}),
        ...(isObj(body.settings) ? { settings: body.settings } : {}),
        ...(typeof body.backend === "string" ? { backend: body.backend } : {}),
      });
      return sendJson(res, 202, { members });
    }
    if (body.action === "send") {
      if (
        !(Array.isArray(body.audience) || body.audience === "all") ||
        (body.notify !== undefined && typeof body.notify !== "boolean") ||
        (body.replyTo !== undefined && typeof body.replyTo !== "string")
      )
        throw new Error("invalid message parameters");
      const message = await app.swarms.send(caller, {
        requestId: body.requestId,
        text: body.text,
        audience: body.audience,
        ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
        ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
      });
      return sendJson(res, 202, { message });
    }
    throw new Error("unknown swarm action");
  } catch (error) {
    return sendJson(res, 400, { error: errMessage(error) });
  }
}

async function swarmMemoryRequest({ app, deps, res, actor, capability, params, method }: ApiCtx): Promise<void> {
  if (!actor || capability) return sendJson(res, 403, { error: "session-bound authentication required" });
  const visible = await app.getSessionForViewer(params.id!, actor.p);
  if (!visible) return sendJson(res, 403, { error: "session access denied" });
  if (!deps.memorable)
    return sendJson(res, 200, {
      memoryCount: 0,
      memoryCountsBySession: {},
      memories: [],
      memoryStatus: "unconfigured",
      message: "Memorable is not configured for this QM instance.",
    });
  const featureSessions = new Map([[params.id!, visible.session.threadRef]]);
  if (app.swarms) {
    try {
      const swarm = await app.swarms.inspect({ kind: "human", actorId: actor.p, sessionId: params.id! });
      for (const member of [swarm.self, ...swarm.peers]) {
        if (!member.sessionId) continue;
        const memberVisible =
          member.sessionId === params.id ? visible : await app.getSessionForViewer(member.sessionId, actor.p);
        if (
          !memberVisible ||
          memberVisible.session.scopeId !== visible.session.scopeId ||
          memberVisible.session.threadRef !== member.threadRef
        )
          return sendJson(res, 403, { error: "swarm member session access denied" });
        featureSessions.set(member.sessionId, memberVisible.session.threadRef);
      }
    } catch {
      return sendJson(res, 400, { error: "swarm access unavailable" });
    }
  }
  try {
    if (method === "POST") {
      if (!deps.memory) return sendJson(res, 503, { error: "memory capture unavailable" });
      for (const threadRef of featureSessions.values()) {
        if ((await deps.runs?.inFlightForThread(threadRef))?.length)
          return sendJson(res, 409, { error: "Wait for feature agents to finish before recording their memories." });
      }
      for (const sessionId of featureSessions.keys())
        await deps.memory.capture(visible.session.scopeId, [], Date.now(), actor.p, {
          mode: "automatic",
          actorId: actor.p,
          sessionId,
        });
    }
    return sendJson(res, 200, await deps.memorable.inspect(visible.session.scopeId, [...featureSessions.keys()]));
  } catch {
    return sendJson(res, 503, {
      memoryCount: 0,
      memoryCountsBySession: {},
      memories: [],
      memoryStatus: "unavailable",
      message: "Memorable storage is temporarily unavailable.",
    });
  }
}

export const swarmRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/swarm", auth: "either", handle: swarmRequest },
  { method: "POST", path: "/v1/swarm", auth: "either", handle: swarmRequest },
  { method: "GET", path: "/v1/sessions/:id/swarm", auth: "source", handle: swarmRequest },
  { method: "POST", path: "/v1/sessions/:id/swarm", auth: "source", handle: swarmRequest },
  { method: "GET", path: "/v1/sessions/:id/swarm/memories", auth: "source", handle: swarmMemoryRequest },
  { method: "POST", path: "/v1/sessions/:id/swarm/memories", auth: "source", handle: swarmMemoryRequest },
];
