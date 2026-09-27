import { html, render } from "lit";
import { api, type CoreSession } from "./core-bridge";
import { inspectSwarm, sendSwarmMessage, spawnSwarmMembers, summarizeSwarmMembers, renewSwarm } from "./swarm-api";
import { createSwarmSnapshotLoader } from "./swarm-snapshot";
import { mountSwarmView, type SwarmSnapshot } from "./swarm-view";
import "./swarm-shell.css";

export function mountSwarmWorkspace(main: HTMLElement, user: string): () => void {
  const host = document.createElement("div");
  host.className = "swarm-page";
  const bar = document.createElement("div");
  bar.className = "swarm-source-bar";
  const world = document.createElement("div");
  world.className = "swarm-page-world";
  host.append(bar, world);
  main.replaceChildren(host);
  let stopped = false;
  let cleanup: (() => void) | undefined;
  let sessions: CoreSession[] = [];
  const sourceKey = `qm-swarm-live-source:${user}`;
  let selected = new URLSearchParams(location.search).get("session") ?? localStorage.getItem(sourceKey) ?? "new";
  if (selected === "demo") selected = "new";
  let error = "";
  let generation = 0;
  const controller = new AbortController();

  const activeSession = () => sessions.find((session) => session.id === selected);
  const drawBar = () => {
    if (stopped) return;
    render(
      html`
        <label for="swarm-source">Workspace</label>
        <select
          id="swarm-source"
          aria-label="Swarm data source"
          @change=${(event: Event) => {
            selected = (event.target as HTMLSelectElement).value;
            localStorage.setItem(sourceKey, selected);
            error = "";
            mount();
            drawBar();
          }}
        >
          <option value="new" .selected=${selected === "new"}>New workspace</option>
          ${sessions
            .filter(
              (session) => !session.threadRef.startsWith("swarm:") && !session.threadRef.includes("swarm-summary"),
            )
            .map(
              (session) => html`
                <option value=${session.id} .selected=${selected === session.id}>
                  ${session.threadRef === `web:${user}:todo-demo` ? "Todo app" : session.title || session.threadRef}
                </option>
              `,
            )}
        </select>
        <span class="swarm-source-note">Real agents · Memorable memory</span>
        ${error ? html`<span role="status" class="swarm-source-error">${error}</span>` : ""}
        <a href="http://localhost:8768" target="_blank" rel="noopener">Open todo app ↗</a>
        <a href=${`swarm.html?session=${encodeURIComponent(selected)}`} target="_blank" rel="noopener">Present ↗</a>
      `,
      bar,
    );
  };

  const refreshSessions = async () => {
    try {
      const result = await api<{ sessions: CoreSession[] }>("/api/sessions", { signal: controller.signal });
      if (stopped) return;
      sessions = result.sessions;
      drawBar();
    } catch (caught) {
      if (stopped) return;
      error = caught instanceof Error ? caught.message : "Could not load sessions";
      drawBar();
    }
  };

  const startMission = async (text: string) => {
    const startedGeneration = generation;
    const workerText = `${text}\nWork according to your role. Delegate only when another agent can take a concrete, bounded task; inspect and reuse existing peers first. You may spawn one or two useful helpers with POST /v1/swarm action spawn, a unique requestId, text, and context containing name, role, and task. Omit context.group to keep helpers on your current planet, or set context.group to a concise distinct feature name when the work deserves a new planet. The shared forum is inherited automatically. State why you delegated and report the child IDs. Do not spawn just to populate the map; preserve the swarm budgets and coordinate file ownership. Read GET /v1/swarm to find the coordinator (depth 0). Report using POST /v1/swarm with {"action":"send","requestId":"<unique id>","audience":["<coordinator member id>"],"text":"<your concise result>","notify":false}. Use the x-agent-capability: $AGENT_API_TOKEN header and $AGENT_API_URL base URL.`;
    const contexts = ["Explorer", "Builder", "Reviewer"].map((role) => ({
      group: text.slice(0, 64),
      role,
      task: text,
      ownership: "Feature team · send follow-up issues to this planet",
    }));
    const session = activeSession();
    if (session) {
      try {
        const inspection = await inspectSwarm(session.id, controller.signal);
        if (Date.now() >= inspection.expiresAt) await renewSwarm(session.id);
        const forumSandboxId = inspection.peers.find((peer) => peer.forumSandboxId)?.forumSandboxId;
        await spawnSwarmMembers(session.id, {
          text: `${workerText}\n${forumSandboxId ? `Use execute with sandbox_id ${forumSandboxId} for the shared todo app at /root/workspace/todo-app. Explorer: inspect and propose without writing implementation files. Builder: implement and run tests. Reviewer: independently verify with read-only tests; report concrete bugs. Keep the node server at /root/workspace/todo-app/server.mjs runnable. Coordinate writes. You continue owning this feature on future messages.` : ""}`,
          contexts,
          ...(forumSandboxId ? { forumSandboxId } : {}),
        });
        return;
      } catch (caught) {
        if (!(caught instanceof Error) || !caught.message.includes("swarm not found")) throw caught;
      }
    }
    const threadRef = session?.threadRef ?? `web:${user}:swarm-${crypto.randomUUID()}`;
    const result = await api<{ runId?: string; reason?: string }>("/api/turn", {
      method: "POST",
      body: JSON.stringify({
        threadRef,
        ...(session ? { scopeId: session.scopeId } : {}),
        fastMode: true,
        text: `Coordinate this mission: ${text}\nThe swarm control surface is provisioning three initial workers with Explorer, Builder, and Reviewer roles. Inspect and reuse these workers before recruiting more. Agents may delegate concrete bounded tasks to helpers on their current planet or create a distinctly named feature planet with context.group when their intent warrants it. Keep work bounded and coordinate file ownership. Use the swarm API to inspect the pool and exchange progress and results with your workers.`,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!result.runId) throw new Error(result.reason ?? "QM could not start the mission");
    for (let attempt = 0; attempt < 20; attempt++) {
      const resultSessions = await api<{ sessions: CoreSession[] }>("/api/sessions");
      const created = resultSessions.sessions.find((item) => item.threadRef === threadRef);
      if (created) {
        await spawnSwarmMembers(created.id, {
          runId: result.runId,
          text: workerText,
          contexts,
        });
        if (stopped || generation !== startedGeneration) return;
        sessions = resultSessions.sessions;
        selected = created.id;
        localStorage.setItem(sourceKey, selected);
        drawBar();
        mount();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!stopped) throw new Error("Mission started. Refresh the session list to connect.");
  };

  const mount = () => {
    if (stopped) return;
    generation++;
    cleanup?.();
    let snapshot: SwarmSnapshot = { features: [], agents: [], messages: [] };
    const session = activeSession();
    const loadSnapshot = session ? createSwarmSnapshotLoader(session.id, controller.signal) : undefined;
    cleanup = mountSwarmView(world, {
      sessionId: session?.id,
      loadSnapshot: async () => {
        if (!loadSnapshot) return snapshot;
        try {
          snapshot = await loadSnapshot();
          return snapshot;
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes("swarm not found")) return snapshot;
          throw caught;
        }
      },
      sendMission: startMission,
      summarizeSelection: async (ids, signal) => {
        if (!session) throw new Error("Launch a mission first");
        return summarizeSwarmMembers(session.id, ids, { signal });
      },
      sendInstruction: async (target, text) => {
        if (!session) throw new Error("Launch a mission to create a live swarm first");
        let audience: string[] | "all" = target.ids;
        if (target.type === "central") audience = "all";
        if (target.type === "feature")
          audience = snapshot.agents
            .filter((agent) => agent.featureId && target.ids.includes(agent.featureId))
            .map((agent) => agent.id);
        if (audience !== "all" && audience.length === 0) throw new Error("Select at least one agent");
        const inspection = await inspectSwarm(session.id);
        if (Date.now() >= inspection.expiresAt) await renewSwarm(session.id);
        await sendSwarmMessage(session.id, { audience, text });
      },
    });
  };

  const lifecycleObserver = new MutationObserver(() => {
    if (host.parentElement !== main) teardown();
  });
  function teardown(): void {
    stopped = true;
    controller.abort();
    lifecycleObserver.disconnect();
    cleanup?.();
  }
  lifecycleObserver.observe(main, { childList: true });
  drawBar();
  mount();
  void refreshSessions().then(() => {
    if (stopped) return;
    const demo = sessions.find((session) => session.threadRef === `web:${user}:todo-demo`);
    if (selected === "new" && demo) selected = demo.id;
    if (!activeSession()) selected = "new";
    drawBar();
    mount();
  });
  return teardown;
}
