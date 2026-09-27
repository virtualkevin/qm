import { html, render, nothing } from "lit";
import { deepLinkPath, UI_BASE } from "./deep-link";
import "./swarm-view.css";

export type SwarmStatus = "active" | "blocked" | "complete" | "idle";
export type SwarmAgent = {
  id: string;
  name: string;
  role: string;
  state: "idle" | "traveling" | "working" | "blocked" | "returning";
  featureId?: string;
  sessionId?: string;
  task?: string;
  summary?: string;
};
export type SwarmFeature = {
  id: string;
  name: string;
  status: SwarmStatus;
  summary: string;
  memoryCount?: number;
  memories?: { id: string; text: string; source?: string; url?: string }[];
  memoryStatus?: "active" | "empty" | "unconfigured" | "unavailable";
  ownership?: string;
  maintenanceActive?: boolean;
  subtasks?: string[];
};
export type SwarmMessage = {
  id: string;
  fromId: string;
  toId: string;
  kind: "status" | "result" | "question" | "error" | "instruction";
  text: string;
  createdAt: number;
};
export type SwarmSnapshot = {
  features: SwarmFeature[];
  agents: SwarmAgent[];
  messages: SwarmMessage[];
  summary?: string;
};
export type SwarmTarget = { type: "agent" | "feature" | "central" | "group"; ids: string[] };
export type SwarmViewOptions = {
  sessionId?: string;
  loadSnapshot?: () => Promise<SwarmSnapshot>;
  sendMission?: (text: string) => Promise<void>;
  sendInstruction?: (target: SwarmTarget, text: string) => Promise<void>;
  summarizeSelection?: (
    agentIds: string[],
    signal?: AbortSignal,
  ) => Promise<{ summary: string; runId?: string; generatedAt?: number }>;
};

type Point = { x: number; y: number };
type Planet = Point & { id: string; radius: number; status: SwarmStatus };
type Particle = Point & { id: string; featureId?: string; state: SwarmAgent["state"] };
type Selection = { type: "central" | "feature" | "agent" | "group"; ids: string[] };
const TAU = Math.PI * 2;
const COLORS = { active: "#77dbdf", blocked: "#e8b875", complete: "#9fc4b1", idle: "#83949e" };
const STATUS_LABELS = { active: "Working", blocked: "Needs input", complete: "Complete", idle: "Ready" };
const MESSAGE_COLORS = {
  status: "#79d9e5",
  result: "#b5e4c5",
  question: "#e7bc7a",
  error: "#e7a080",
  instruction: "#bdacf0",
};

function seedValue(value: string): number {
  let n = 7;
  for (const character of value) n = (n * 31 + character.charCodeAt(0)) >>> 0;
  return n;
}

export function memoryRadius(count = 0): number {
  return 32 + Math.log2(1 + Math.max(0, Number.isFinite(count) ? count : 0)) * 8;
}

function elapsedLabel(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function agentColor(state: SwarmAgent["state"]): string {
  if (state === "blocked") return COLORS.blocked;
  if (state === "idle") return "#93a7af";
  return "#b9f3ee";
}

export function mountSwarmView(container: HTMLElement, options: SwarmViewOptions = {}): () => void {
  let data: SwarmSnapshot = { features: [], agents: [], messages: [] };
  let selection: Selection = { type: "central", ids: ["central"] };
  let inspectorOpen = false;
  let paused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let panTool = false;
  let spaceHeld = false;
  let zoom = 1;
  let offset = { x: 0, y: 0 };
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let time = 0;
  let lastFrame = 0;
  let frame = 0;
  let disposed = false;
  let busy = false;
  let loading = Boolean(options.loadSnapshot);
  let disconnected = false;
  let refreshPending = false;
  let notice = "";
  let hover = "";
  let pointerStart: Point | null = null;
  let pointerNow: Point | null = null;
  let offsetStart: Point = { x: 0, y: 0 };
  let draggingPan = false;
  let planets: Planet[] = [];
  let particles: Particle[] = [];
  const pulseTimes = new Map<string, number>();
  let summary = "";
  let summaryError = "";
  let summaryLoading = false;
  let summaryGeneratedAt: number | undefined;
  let summaryVersion = 0;
  let summaryController: AbortController | undefined;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearSummary(): void {
    summaryVersion++;
    summaryController?.abort();
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = undefined;
    summary = "";
    summaryError = "";
    summaryLoading = false;
    summaryGeneratedAt = undefined;
  }

  async function summarizeSelection(): Promise<void> {
    if (disposed || selection.type !== "group") return;
    const ids = selectedAgents().map((agent) => agent.id);
    if (ids.length < 2) return;
    clearSummary();
    const version = summaryVersion;
    if (!options.summarizeSelection) {
      summaryError = "Agent summaries are unavailable. Recent activity is shown below.";
      updateUI();
      return;
    }
    summaryLoading = true;
    summaryController = new AbortController();
    updateUI();
    try {
      const result = await options.summarizeSelection(ids, summaryController.signal);
      if (disposed || version !== summaryVersion) return;
      if (!result.summary.trim()) throw new Error("QM returned an empty summary. Try again.");
      summary = result.summary;
      summaryGeneratedAt = result.generatedAt ?? Date.now();
    } catch (error) {
      if (disposed || version !== summaryVersion) return;
      summaryError = error instanceof Error ? error.message : "Could not summarize the selected agents.";
    } finally {
      if (!disposed && version === summaryVersion) {
        summaryLoading = false;
        updateUI();
      }
    }
  }

  function select(type: Selection["type"], ids: string[]): void {
    clearSummary();
    selection = { type, ids };
    inspectorOpen = true;
    if (type === "group") {
      summaryLoading = true;
      summaryTimer = setTimeout(() => {
        summaryTimer = undefined;
        void summarizeSelection();
      }, 250);
    }
    updateUI();
  }

  function featureAgents(id: string): SwarmAgent[] {
    return data.agents.filter((agent) => agent.featureId === id);
  }

  function selectedAgents(): SwarmAgent[] {
    if (selection.type === "agent" || selection.type === "group")
      return data.agents.filter((agent) => selection.ids.includes(agent.id));
    if (selection.type === "feature") return featureAgents(selection.ids[0]);
    return data.agents;
  }

  function targetName(id: string): string {
    return id === "central"
      ? "QM colony"
      : (data.features.find((feature) => feature.id === id)?.name ??
          data.agents.find((agent) => agent.id === id)?.name ??
          id);
  }

  function visibleMessages(): SwarmMessage[] {
    const ids = new Set([...selection.ids, ...selectedAgents().map((agent) => agent.id)]);
    if (selection.type === "agent") {
      const agent = selectedAgents()[0];
      if (agent?.featureId) ids.add(agent.featureId);
    }
    const seen = new Set<string>();
    return data.messages
      .filter((message) => {
        if (selection.type !== "central" && !ids.has(message.fromId) && !ids.has(message.toId)) return false;
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      })
      .slice(0, 8);
  }

  function updateUI(): void {
    if (disposed) return;
    const feature =
      selection.type === "feature" ? data.features.find((item) => item.id === selection.ids[0]) : undefined;
    const agent = selection.type === "agent" ? data.agents.find((item) => item.id === selection.ids[0]) : undefined;
    const selected = selectedAgents();
    const blocked = selected.filter((item) => item.state === "blocked").length;
    const activeFeatures = data.features.filter((item) => item.status === "active" || item.status === "blocked");
    let streamStatus = "Live activity";
    if (loading) streamStatus = "Connecting";
    if (disconnected) streamStatus = "Disconnected";
    const selectionSymbol = { central: "✳", group: "⠿", feature: "◉", agent: agent?.name.slice(0, 1) ?? "◉" }[
      selection.type
    ];
    const title =
      feature?.name ?? agent?.name ?? (selection.type === "group" ? `${selected.length} agents selected` : "QM colony");
    const status = feature?.status ?? agent?.state ?? "Coordinating";
    const selectionSummary =
      feature?.summary ??
      agent?.summary ??
      (selection.type === "group"
        ? ""
        : (data.summary ?? "Live missions and agent activity from your local QM instance."));
    let groupSummaryContent = html`<p class="swarm-summary">${summary}</p>`;
    if (summaryLoading)
      groupSummaryContent = html`<p class="swarm-summary swarm-summary-loading">
        Reading the selected agents’ recent messages…
      </p>`;
    else if (summaryError) groupSummaryContent = html`<p class="swarm-summary-error" role="alert">${summaryError}</p>`;
    let memoryContent = html`<p class="swarm-muted">No related memories yet.</p>`;
    if (feature?.memoryStatus === "unconfigured")
      memoryContent = html`<p class="swarm-muted">Memorable is not connected.</p>`;
    else if (feature?.memoryStatus === "unavailable")
      memoryContent = html`<p class="swarm-summary-error">Memories could not be loaded.</p>`;
    else if (feature?.memories?.length)
      memoryContent = html`<ul class="swarm-memory-list">
        ${feature.memories.map(
          (memory) =>
            html`<li>
              <p>${memory.text}</p>
              ${memory.url && /^https?:\/\//.test(memory.url) ? html`<a href=${memory.url} target="_blank" rel="noopener noreferrer">${memory.source ?? "Memory source"} ↗</a>` : html`<small>${memory.source ?? "Memorable"}</small>`}
            </li>`,
        )}
      </ul>`;
    render(
      html`
        <div class="swarm-workspace ${inspectorOpen ? "has-inspector" : ""}">
          <header class="swarm-header">
            <div class="swarm-heading">
              <span class="swarm-logomark" aria-hidden="true">✳</span>
              <div>
                <h1>Swarm</h1>
                <p>Mission control</p>
              </div>
              <span class="swarm-header-divider"></span><span class="swarm-environment"><i></i> Local workspace</span>
            </div>
            <div class="swarm-header-actions">
              <span class="swarm-mode-badge" aria-label="Data source">LIVE</span>
              <button
                class="swarm-icon-button swarm-pause"
                aria-label=${paused ? "Resume animation" : "Pause animation"}
                title=${paused ? "Resume animation" : "Pause animation"}
                @click=${() => {
                  paused = !paused;
                  updateUI();
                }}
              >
                ${paused ? "▷" : "Ⅱ"}
              </button>
            </div>
          </header>
          <div class="swarm-body">
            <main class="swarm-stage ${panTool || spaceHeld ? "is-pan" : ""}">
              <canvas
                class="swarm-canvas"
                tabindex="0"
                aria-label="Interactive swarm map. Select a mission from the mission list, click an agent to inspect it, or drag to select a group. Hold Space to pan; scroll to zoom."
              ></canvas>
              <div class="swarm-map-heading">
                <div class="swarm-eyebrow">LOCAL QM / LIVE</div>
                <div class="swarm-map-title">Mission overview</div>
                <div class="swarm-map-stats">
                  <span><b>${data.agents.length}</b> agents</span
                  ><span><b>${activeFeatures.length}</b> active missions</span
                  ><span class="swarm-stream-indicator"
                    ><i class=${disconnected ? "is-paused" : ""}></i>${streamStatus}</span
                  >
                </div>
              </div>
              <nav class="swarm-mission-list" aria-label="Missions">
                ${data.features.map((item) => html`<button class="swarm-mission-item ${selection.type === "feature" && selection.ids[0] === item.id ? "is-selected" : ""}" @click=${() => select("feature", [item.id])}><span class="swarm-state-dot" style=${`background:${COLORS[item.status]}`}></span><span>${item.name}</span><span class="swarm-mission-count">${featureAgents(item.id).length}</span></button>`)}
              </nav>
              ${
                data.features.length === 0 && !loading
                  ? html`<div class="swarm-empty">
                      <h2>Ready for your first feature</h2>
                      <p>Launch a feature below. Its agents and memories appear here as they work.</p>
                    </div>`
                  : nothing
              }
              <div class="swarm-map-tools">
                <button
                  class=${!panTool ? "is-active" : ""}
                  aria-label="Select agents"
                  title="Select agents by dragging"
                  @click=${() => {
                    panTool = false;
                    updateUI();
                  }}
                >
                  ↖</button
                ><button
                  class=${panTool ? "is-active" : ""}
                  aria-label="Pan map"
                  title="Pan map (or hold Space)"
                  @click=${() => {
                    panTool = true;
                    updateUI();
                  }}
                >
                  ✥</button
                ><span></span><button aria-label="Zoom in" @click=${() => setZoom(zoom * 1.2)}>+</button
                ><button aria-label="Zoom out" @click=${() => setZoom(zoom / 1.2)}>−</button
                ><button
                  class="swarm-fit"
                  aria-label="Fit map"
                  title="Fit map"
                  @click=${() => {
                    zoom = 1;
                    offset = { x: 0, y: 0 };
                    updateUI();
                  }}
                >
                  ⌖</button
                ><small>${Math.round(zoom * 100)}%</small>
              </div>
              <div class="swarm-map-legend">
                <span><i style="background:#77dbdf"></i>Working</span
                ><span><i style="background:#e8b875"></i>Needs input</span
                ><span><i style="background:#9fc4b1"></i>Complete</span>
              </div>
              <div class="swarm-launch-area">
                ${
                  notice
                    ? html`<div class="swarm-notice" role="status">
                        ${notice}<button
                          aria-label="Dismiss notification"
                          @click=${() => {
                            notice = "";
                            updateUI();
                          }}
                        >
                          ×
                        </button>
                      </div>`
                    : nothing
                }
                <button
                  class="swarm-mission-suggestion"
                  ?disabled=${busy || !options.sendMission}
                  @click=${() => {
                    const input = container.querySelector<HTMLInputElement>('input[name="mission"]');
                    if (input) {
                      input.value = "Add list reordering to the todo app with drag-and-drop and persistent order";
                      input.focus();
                    }
                  }}
                >
                  Add list reordering <span>↗</span>
                </button>
                <form class="swarm-launch" @submit=${launchMission}>
                  <span class="swarm-launch-icon" aria-hidden="true">↗</span
                  ><input
                    name="mission"
                    aria-label="New mission"
                    placeholder="Give your todo app a new feature…"
                    maxlength="600"
                    ?disabled=${busy || !options.sendMission}
                    autocomplete="off"
                  /><button type="submit" ?disabled=${busy || !options.sendMission}>
                    ${busy ? "Launching…" : "Launch mission"}<span>↵</span>
                  </button>
                </form>
                <div class="swarm-bottom-hint">
                  ${streamStatus} · local QM<span>Drag to select · Space to pan · Scroll to zoom</span>
                </div>
              </div>
            </main>
            <aside class="swarm-inspector" aria-label="Swarm inspector">
              <div class="swarm-inspector-tabs">
                <span>Inspector</span
                ><span class="swarm-inspector-index"
                  >${selection.type === "central" ? "OVERVIEW" : selection.type.toUpperCase()}</span
                >
                <button
                  class="swarm-inspector-close"
                  aria-label="Close inspector"
                  @click=${() => {
                    inspectorOpen = false;
                    updateUI();
                  }}
                >
                  ×
                </button>
              </div>
              <div class="swarm-inspector-content">
                <div
                  class="swarm-selection-symbol ${feature?.status === "blocked" || agent?.state === "blocked" ? "is-blocked" : ""}"
                >
                  ${selectionSymbol}
                </div>
                <div class="swarm-selected-status">
                  <i
                    style=${`background:${COLORS[feature?.status ?? (agent?.state === "blocked" ? "blocked" : "active")]}`}
                  ></i
                  >${status}
                </div>
                <h2>${title}</h2>
                ${
                  selection.type === "group"
                    ? html` <section class="swarm-group-summary" aria-live="polite" aria-busy=${summaryLoading}>
                        <div class="swarm-summary-heading">
                          <span>Agent overview</span
                          ><button
                            class="swarm-text-button"
                            @click=${() => void summarizeSelection()}
                            ?disabled=${summaryLoading}
                          >
                            ${summaryError ? "Try again" : "Refresh"}
                          </button>
                        </div>
                        ${groupSummaryContent}
                        ${summaryGeneratedAt ? html`<small class="swarm-summary-time">Summarized ${elapsedLabel(summaryGeneratedAt)} · from recent agent messages</small>` : nothing}
                      </section>`
                    : html`<p class="swarm-summary">${selectionSummary}</p>`
                }
                ${agent?.sessionId ? html`<a class="swarm-trace-link" href=${deepLinkPath(UI_BASE, "chats", agent.sessionId)} target="_blank" rel="noopener">Open activity trace ↗</a>` : nothing}
                <div class="swarm-inspector-metrics">
                  <div>
                    <strong>${agent ? agent.role : selected.length}</strong><span>${agent ? "ROLE" : "AGENTS"}</span>
                  </div>
                  <div>
                    <strong>${feature ? (feature.memoryCount ?? "—") : blocked || "—"}</strong
                    ><span>${feature ? "MEMORIES" : "BLOCKERS"}</span>
                  </div>
                </div>
                ${
                  feature
                    ? html`
                        <div class="swarm-inspector-section swarm-memory-section">
                          <h3>Feature memory<span>MEMORABLE</span></h3>
                          <p class="swarm-muted">Planet size reflects related memories.</p>
                          ${memoryContent}
                        </div>
                        ${
                          feature.ownership
                            ? html`<div class="swarm-inspector-section">
                                <h3>Feature ownership</h3>
                                <p class="swarm-task-description">${feature.ownership}</p>
                                <p class="swarm-muted">
                                  ${feature.maintenanceActive ? "Maintenance monitoring is active." : "The assigned team remains responsible. Send an instruction to resume work."}
                                </p>
                              </div>`
                            : nothing
                        }
                      `
                    : nothing
                }
                ${
                  agent?.task
                    ? html`<div class="swarm-inspector-section">
                        <h3>Current task</h3>
                        <p class="swarm-task-description">${agent.task}</p>
                      </div>`
                    : nothing
                }
                ${
                  feature?.subtasks?.length
                    ? html`<div class="swarm-inspector-section">
                        <h3>Mission plan</h3>
                        <ol class="swarm-subtasks">
                          ${feature.subtasks.map((task, index) => html`<li><span>${String(index + 1).padStart(2, "0")}</span>${task}</li>`)}
                        </ol>
                      </div>`
                    : nothing
                }
                ${
                  !agent
                    ? html`<div class="swarm-inspector-section">
                        <h3>
                          ${selection.type === "central" ? "Crew" : "Assigned agents"}<span>${selected.length}</span>
                        </h3>
                        <div class="swarm-agent-list">
                          ${selected.slice(0, selection.type === "central" ? 6 : selected.length).map(
                            (item) =>
                              html`<button
                                aria-label=${`Inspect ${item.name}`}
                                @click=${() => select("agent", [item.id])}
                              >
                                <span class="swarm-agent-avatar">${item.name.slice(0, 1)}</span
                                ><span>${item.name}<small>${item.role}</small></span
                                ><i style=${`background:${agentColor(item.state)}`}></i>
                              </button>`,
                          )}
                        </div>
                        ${
                          selection.type !== "group" && selected.length > 1
                            ? html`<button
                                class="swarm-text-button"
                                @click=${() =>
                                  select(
                                    "group",
                                    selected.map((item) => item.id),
                                  )}
                              >
                                Summarize ${selected.length} agents →
                              </button>`
                            : nothing
                        }
                      </div>`
                    : nothing
                }
                <div class="swarm-inspector-section swarm-activity">
                  <h3>Recent activity<span>LIVE</span></h3>
                  ${
                    visibleMessages().length
                      ? visibleMessages().map(
                          (message) =>
                            html`<div class="swarm-activity-item">
                              <i style=${`background:${MESSAGE_COLORS[message.kind]}`}></i>
                              <div>
                                <div class="swarm-activity-meta">
                                  <strong>${targetName(message.fromId)}</strong
                                  ><time>${elapsedLabel(message.createdAt)}</time>
                                </div>
                                <p>${message.text}</p>
                              </div>
                            </div>`,
                        )
                      : html`<p class="swarm-muted">Activity appears here as the agents work.</p>`
                  }
                </div>
              </div>
              <form class="swarm-instruction" @submit=${sendInstruction}>
                <label for="swarm-instruction-input"
                  >${selection.type === "group" ? "Message selected agents" : `Message ${title}`}</label
                >
                <div>
                  <input
                    id="swarm-instruction-input"
                    name="instruction"
                    maxlength="1000"
                    placeholder="Send an instruction…"
                    ?disabled=${busy || !options.sendInstruction}
                    autocomplete="off"
                  /><button aria-label="Send instruction" ?disabled=${busy || !options.sendInstruction}>↑</button>
                </div>
              </form>
            </aside>
          </div>
        </div>
      `,
      container,
    );
  }

  async function refreshLive(): Promise<void> {
    if (!options.loadSnapshot || disposed || refreshPending) return;
    refreshPending = true;
    try {
      const next = await options.loadSnapshot();
      if (disposed) return;
      const existing = new Set(data.messages.map((message) => message.id));
      for (const message of next.messages) if (!loading && !existing.has(message.id)) pulseTimes.set(message.id, time);
      data = next;
      const currentMessageIds = new Set(data.messages.map((message) => message.id));
      for (const id of pulseTimes.keys()) if (!currentMessageIds.has(id)) pulseTimes.delete(id);
      disconnected = false;
      notice = "";
    } catch (error) {
      if (disposed) return;
      notice = error instanceof Error ? error.message : "Could not connect to local QM.";
      disconnected = true;
    }
    refreshPending = false;
    loading = false;
    updateUI();
  }

  async function launchMission(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("mission") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    notice = "";
    updateUI();
    try {
      if (!options.sendMission) throw new Error("Mission launch is unavailable.");
      await options.sendMission(text);
      await refreshLive();
      notice = "Mission sent to QM. Agent activity will appear as work begins.";
      input.value = "";
    } catch (error) {
      notice = error instanceof Error ? error.message : "The mission could not be launched.";
    } finally {
      busy = false;
      updateUI();
    }
  }

  async function sendInstruction(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("instruction") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || busy) return;
    const target: SwarmTarget = { type: selection.type, ids: [...selection.ids] };
    busy = true;
    updateUI();
    try {
      if (!options.sendInstruction) throw new Error("Messaging is unavailable.");
      await options.sendInstruction(target, text);
      await refreshLive();
      input.value = "";
      notice = "Instruction sent to QM.";
    } catch (error) {
      notice = error instanceof Error ? error.message : "Could not send instruction.";
    } finally {
      busy = false;
      updateUI();
    }
  }

  function setZoom(next: number): void {
    zoom = Math.max(0.45, Math.min(2.4, next));
    updateUI();
  }

  function scale(): number {
    return Math.min(width / 900, Math.max(220, height - 100) / 790) * zoom;
  }
  function origin(): Point {
    return { x: width * 0.59 + offset.x, y: height * 0.48 + offset.y };
  }
  function world(point: Point): Point {
    const center = origin();
    const size = scale();
    return { x: (point.x - center.x) / size, y: (point.y - center.y) / size };
  }
  function pointerPoint(event: PointerEvent): Point {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function layout(): void {
    const predefined = [
      { x: -236, y: -125 },
      { x: 218, y: -154 },
      { x: 225, y: 146 },
      { x: -210, y: 168 },
      { x: 8, y: -278 },
    ];
    planets = [
      { id: "central", x: 0, y: 0, radius: 78, status: "active" },
      ...data.features.map((feature, index) => {
        const point =
          data.features.length <= 5 && index < predefined.length
            ? predefined[index]
            : {
                x: Math.cos(-2.65 + (index * TAU) / Math.max(6, data.features.length)) * (index < 6 ? 286 : 430),
                y: Math.sin(-2.65 + (index * TAU) / Math.max(6, data.features.length)) * (index < 6 ? 230 : 315),
              };
        return {
          id: feature.id,
          ...point,
          radius: memoryRadius(feature.memoryCount),
          status: feature.status,
        };
      }),
    ];
    particles = data.agents.map((agent, index) => {
      const planet = planets.find((item) => item.id === agent.featureId) ?? planets[0];
      const seed = seedValue(agent.id);
      const angle =
        (seed % 628) / 100 +
        (agent.state === "working" ? time * (0.035 + (seed % 13) * 0.003) * (index % 2 ? 1 : -1) : 0);
      const radius = planet.radius * (0.84 + (seed % 35) / 100);
      return {
        id: agent.id,
        featureId: agent.featureId,
        state: agent.state,
        x: planet.x + Math.cos(angle) * radius,
        y: planet.y + Math.sin(angle) * radius * 0.8,
      };
    });
  }

  function nodePoint(id: string): Point | undefined {
    return planets.find((planet) => planet.id === id) ?? particles.find((particle) => particle.id === id);
  }

  function draw(): void {
    const ctx = context;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < 110; i++) {
      const x = (((i * 157.83 + 71) % 997) / 997) * width;
      const y = (((i * 213.71 + 29) % 991) / 991) * height;
      ctx.fillStyle = `rgba(176,208,220,${0.09 + (i % 4) * 0.035})`;
      ctx.beginPath();
      ctx.arc(x, y, i % 7 === 0 ? 1 : 0.55, 0, TAU);
      ctx.fill();
    }
    const center = origin();
    const size = scale();
    ctx.translate(center.x, center.y);
    ctx.scale(size, size);
    layout();
    ctx.lineWidth = 1 / size;
    for (const radius of [154, 290, 423]) {
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, radius * 0.83, -0.12, 0, TAU);
      ctx.strokeStyle = "rgba(142,173,188,0.055)";
      ctx.stroke();
    }
    for (const planet of planets.slice(1)) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(planet.x, planet.y);
      ctx.strokeStyle = planet.status === "blocked" ? "rgba(232,184,117,0.12)" : "rgba(119,219,223,0.09)";
      ctx.setLineDash([3, 7]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const planet of planets) {
      const color = COLORS[planet.status];
      const selected =
        selection.ids.includes(planet.id) && (selection.type === "feature" || selection.type === "central");
      const core = planet.id === "central";
      const pulse = 1 + Math.sin(time * 0.8 + planet.x) * 0.015;
      const radius = planet.radius * pulse;
      const glow = ctx.createRadialGradient(planet.x, planet.y, radius * 0.35, planet.x, planet.y, radius * 2.1);
      glow.addColorStop(0, `${color}${core ? "19" : "10"}`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(planet.x, planet.y, radius * 2.1, 0, TAU);
      ctx.fill();
      const body = ctx.createRadialGradient(
        planet.x - radius * 0.35,
        planet.y - radius * 0.4,
        0,
        planet.x,
        planet.y,
        radius,
      );
      const surfaceColor = planet.status === "blocked" ? "#292724" : "#14282f";
      body.addColorStop(0, core ? "#16343e" : surfaceColor);
      body.addColorStop(0.7, core ? "#11272f" : "#0d1c23");
      body.addColorStop(1, "#0b181f");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(planet.x, planet.y, radius, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `${color}${core ? "75" : "48"}`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.save();
      ctx.translate(planet.x, planet.y);
      ctx.rotate(-0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.17, radius * 0.45, 0, 0, TAU);
      ctx.strokeStyle = `${color}24`;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 0.52, radius * 0.92, 0, 0, TAU);
      ctx.strokeStyle = `${color}14`;
      ctx.stroke();
      ctx.restore();
      if (selected || hover === planet.id) {
        ctx.beginPath();
        ctx.arc(planet.x, planet.y, radius + 11, 0, TAU);
        ctx.strokeStyle = `${color}${selected ? "85" : "40"}`;
        ctx.setLineDash([3, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 4 + (i * Math.PI) / 2;
          const x = planet.x + Math.cos(a) * (radius + 12);
          const y = planet.y + Math.sin(a) * (radius + 12);
          ctx.fillStyle = color;
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      }
      ctx.textAlign = "center";
      if (core) {
        ctx.fillStyle = "#e6f5f5";
        ctx.font = `500 ${24 / size}px Inter, system-ui, sans-serif`;
        ctx.fillText("QM", planet.x, planet.y + 4);
        ctx.fillStyle = "#78a1aa";
        ctx.font = `${8 / size}px ui-monospace, monospace`;
        ctx.fillText("C O L O N Y", planet.x, planet.y + 21 / size);
        ctx.fillStyle = "#b8ccd2";
        ctx.font = `500 ${11 / size}px Inter, system-ui, sans-serif`;
        ctx.fillText("Main swarm", planet.x, planet.y + radius + 25 / size);
      } else {
        const feature = data.features.find((item) => item.id === planet.id)!;
        ctx.fillStyle = `${color}cc`;
        ctx.font = `400 ${13 / size}px ui-monospace, monospace`;
        ctx.fillText(feature.memoryCount === undefined ? "—" : `${feature.memoryCount}`, planet.x, planet.y + 5);
        ctx.fillStyle = "#d4e1e5";
        ctx.font = `500 ${11 / size}px Inter, system-ui, sans-serif`;
        ctx.fillText(
          feature.name.length > 29 ? `${feature.name.slice(0, 27)}…` : feature.name,
          planet.x,
          planet.y + radius + 23 / size,
        );
        ctx.fillStyle = feature.status === "blocked" ? color : "#6f8a96";
        ctx.font = `${9 / size}px Inter, system-ui, sans-serif`;
        ctx.fillText(
          `${feature.memoryCount ?? "—"} ${feature.memoryCount === 1 ? "memory" : "memories"}  ·  ${STATUS_LABELS[feature.status]}`,
          planet.x,
          planet.y + radius + 39 / size,
        );
      }
    }
    for (const particle of particles) {
      const selected =
        (selection.type === "agent" || selection.type === "group") && selection.ids.includes(particle.id);
      const color = agentColor(particle.state);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, selected || hover === particle.id ? 5.2 : 3.1, 0, TAU);
      ctx.shadowColor = color;
      ctx.shadowBlur = selected ? 12 : 5;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (selected) {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, 9, 0, TAU);
        ctx.strokeStyle = "#bcf7f5";
        ctx.stroke();
      }
      if (hover === particle.id) {
        ctx.fillStyle = "#ecf8f8";
        ctx.font = `${11 / size}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(targetName(particle.id), particle.x, particle.y - 15 / size);
      }
    }
    const animatedMessages = data.messages.slice(0, 10);
    for (const message of animatedMessages) {
      const start = nodePoint(message.fromId);
      const end = nodePoint(message.toId);
      if (!start || !end) continue;
      const initial = pulseTimes.get(message.id);
      const age = initial !== undefined ? time - initial : 10;
      if (age < 0 || age > 2.1) continue;
      const progress = age / 2.1;
      const tail = Math.max(0, progress - 0.14);
      const x = start.x + (end.x - start.x) * progress;
      const y = start.y + (end.y - start.y) * progress;
      const tx = start.x + (end.x - start.x) * tail;
      const ty = start.y + (end.y - start.y) * tail;
      const color = MESSAGE_COLORS[message.kind];
      const beam = ctx.createLinearGradient(tx, ty, x + 0.01, y + 0.01);
      beam.addColorStop(0, `${color}00`);
      beam.addColorStop(1, color);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.strokeStyle = beam;
      ctx.lineWidth = 2 / size;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.2 / size, 0, TAU);
      ctx.fillStyle = "#f1ffff";
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    if (pointerStart && pointerNow && !draggingPan) {
      const first = world(pointerStart);
      const last = world(pointerNow);
      ctx.fillStyle = "rgba(119,219,223,0.065)";
      ctx.strokeStyle = "rgba(119,219,223,0.6)";
      ctx.lineWidth = 1 / size;
      ctx.fillRect(first.x, first.y, last.x - first.x, last.y - first.y);
      ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
    }
  }

  function animate(now: number): void {
    if (disposed) return;
    if (lastFrame && !paused) time += Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    draw();
    frame = requestAnimationFrame(animate);
  }

  function hitTest(point: Point): { type: "agent" | "feature" | "central"; id: string } | undefined {
    const coordinate = world(point);
    const agent = particles.find((item) => Math.hypot(item.x - coordinate.x, item.y - coordinate.y) < 12 / scale());
    if (agent) return { type: "agent", id: agent.id };
    const planet = planets.find((item) => Math.hypot(item.x - coordinate.x, item.y - coordinate.y) < item.radius + 7);
    if (planet) return { type: planet.id === "central" ? "central" : "feature", id: planet.id };
    return undefined;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1) return;
    canvas.focus();
    pointerStart = pointerPoint(event);
    pointerNow = pointerStart;
    offsetStart = { ...offset };
    draggingPan = panTool || spaceHeld || event.button === 1;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const point = pointerPoint(event);
    if (pointerStart) {
      pointerNow = point;
      if (draggingPan)
        offset = { x: offsetStart.x + point.x - pointerStart.x, y: offsetStart.y + point.y - pointerStart.y };
    } else {
      hover = hitTest(point)?.id ?? "";
      const selectionCursor = hover ? "pointer" : "crosshair";
      canvas.style.cursor = panTool || spaceHeld ? "grab" : selectionCursor;
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pointerStart) return;
    const end = pointerPoint(event);
    if (!draggingPan) {
      if (Math.hypot(end.x - pointerStart.x, end.y - pointerStart.y) < 6) {
        const target = hitTest(end);
        if (target) select(target.type, [target.id]);
        else select("central", ["central"]);
      } else {
        const first = world(pointerStart);
        const last = world(end);
        const ids = particles
          .filter(
            (item) =>
              item.x >= Math.min(first.x, last.x) &&
              item.x <= Math.max(first.x, last.x) &&
              item.y >= Math.min(first.y, last.y) &&
              item.y <= Math.max(first.y, last.y),
          )
          .map((item) => item.id);
        if (ids.length) select(ids.length === 1 ? "agent" : "group", ids);
      }
    }
    pointerStart = null;
    pointerNow = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function onPointerCancel(): void {
    pointerStart = null;
    pointerNow = null;
  }
  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.001));
  }
  function onKeyDown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).matches("input,textarea,button")) return;
    if (event.code === "Space") {
      event.preventDefault();
      spaceHeld = true;
      canvas.style.cursor = "grab";
    }
    if (event.key === "Escape") {
      select("central", ["central"]);
      pointerStart = null;
      pointerNow = null;
    }
    if (event.key === "+" || event.key === "=") setZoom(zoom * 1.2);
    if (event.key === "-") setZoom(zoom / 1.2);
  }
  function onKeyUp(event: KeyboardEvent): void {
    if (event.code === "Space") {
      spaceHeld = false;
      canvas.style.cursor = panTool ? "grab" : "crosshair";
    }
  }
  function resize(): void {
    const bounds = stage.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
  }

  updateUI();
  const canvas = container.querySelector<HTMLCanvasElement>(".swarm-canvas")!;
  const stage = container.querySelector<HTMLElement>(".swarm-stage")!;
  const context = canvas.getContext("2d")!;
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("keyup", onKeyUp);
  const uiTimer = window.setInterval(updateUI, 2000);
  const liveTimer = window.setInterval(() => {
    void refreshLive();
  }, 4000);
  frame = requestAnimationFrame(animate);
  void refreshLive();
  return () => {
    disposed = true;
    clearSummary();
    cancelAnimationFrame(frame);
    clearInterval(uiTimer);
    clearInterval(liveTimer);
    observer.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("wheel", onWheel);
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("keyup", onKeyUp);
    render(nothing, container);
  };
}
