import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { SwarmSnapshot, SwarmTarget, SwarmViewOptions } from "../src/swarm-view.ts";

test("swarm view interactions", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/swarm" });
  const doc = dom.window.document;
  const host = doc.querySelector<HTMLElement>("#app")!;
  const frames = new Map<number, FrameRequestCallback>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let nextFrame = 0;
  let observers = 0;
  const gradient = { addColorStop() {} };
  const context = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "createRadialGradient" || key === "createLinearGradient" ? () => gradient : () => undefined,
    },
  );
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false }) });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => context });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "setPointerCapture", { value: () => undefined });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "hasPointerCapture", { value: () => false });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 703, bottom: 600, width: 703, height: 600 }),
  });
  Object.defineProperty(dom.window, "setInterval", {
    value: (callback: TimerHandler, delay: number) => {
      const timer = originalSetInterval(callback as () => void, delay);
      intervals.add(timer);
      return timer;
    },
  });
  const globals = {
    window: dom.window,
    document: doc,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    customElements: dom.window.customElements,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      intervals.delete(id);
      originalClearInterval(id);
    },
    ResizeObserver: class {
      observe() {
        observers++;
      }
      disconnect() {
        observers--;
      }
    },
  };
  const originalGlobals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { mountSwarmView: mountView, memoryRadius } = (await vite.ssrLoadModule("/src/swarm-view.ts")) as {
    mountSwarmView: (container: HTMLElement, options?: SwarmViewOptions) => () => void;
    memoryRadius: (count?: number) => number;
  };
  const cleanups = new Set<() => void>();
  const mountSwarmView = (container: HTMLElement, options?: SwarmViewOptions) => {
    const stop = mountView(container, options);
    const cleanup = () => {
      if (!cleanups.delete(cleanup)) return;
      stop();
    };
    cleanups.add(cleanup);
    return cleanup;
  };
  t.afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const button = (label: string) => {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === label || item.textContent?.trim().startsWith(label),
    );
    assert.ok(found, `Button ${label} exists`);
    return found;
  };
  const submit = (formSelector: string, inputName: string, text: string) => {
    const form = host.querySelector<HTMLFormElement>(formSelector)!;
    const input = form.elements.namedItem(inputName) as HTMLInputElement;
    input.value = text;
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  };
  const frame = (timestamp: number) => {
    const pending = [...frames];
    frames.clear();
    for (const [, callback] of pending) callback(timestamp);
  };
  const pointer = (kind: string, x: number, y: number) => {
    const event = new dom.window.MouseEvent(kind, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    host.querySelector("canvas")!.dispatchEvent(event);
  };
  t.after(async () => {
    for (const timer of intervals) originalClearInterval(timer);
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const snapshot: SwarmSnapshot = {
    features: [
      {
        id: "storage",
        name: "Database and storage",
        status: "active",
        summary: "Reviewing persistence.",
        memoryCount: 2,
        memoryStatus: "active",
        memories: [
          { id: "memory-1", text: "Persist todos in SQLite.", source: "Memorable" },
          { id: "memory-2", text: "Use stable IDs for list ordering.", source: "Memorable" },
        ],
        ownership: "This team owns todo persistence and future storage fixes.",
      },
    ],
    agents: [
      { id: "builder", name: "Storage builder", role: "Builder", state: "working", featureId: "storage" },
      { id: "reviewer", name: "Storage reviewer", role: "Reviewer", state: "idle", featureId: "storage" },
    ],
    messages: [
      {
        id: "real-message",
        fromId: "builder",
        toId: "central",
        kind: "status",
        text: "The migration is ready for review.",
        createdAt: Date.now(),
      },
    ],
  };
  const dragAll = () => {
    frame(1000);
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 703, 600);
    pointer("pointerup", 703, 600);
  };
  const debounce = () => new Promise((resolve) => setTimeout(resolve, 280));

  await t.test("the view is empty until backend data arrives and never invents activity", async () => {
    const cleanup = mountSwarmView(host);
    assert.equal(host.querySelectorAll(".swarm-mission-item").length, 0);
    assert.equal(host.querySelectorAll(".swarm-activity-item").length, 0);
    assert.equal(host.querySelector<HTMLInputElement>('input[name="mission"]')?.disabled, true);
    assert.doesNotMatch(host.textContent!, /Simulation|Semantic search|Authentication|DEMO/);
    frame(1000);
    for (let i = 1; i <= 100; i++) frame(1000 + i * 1000);
    assert.equal(host.querySelectorAll(".swarm-mission-item").length, 0);
    assert.equal(host.querySelectorAll(".swarm-activity-item").length, 0);
    cleanup();
    assert.equal(frames.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal(observers, 0);
  });

  await t.test("launch waits for backend state and real memories determine planet size", async () => {
    let resolveLaunch!: () => void;
    let launched = false;
    const cleanup = mountSwarmView(host, {
      loadSnapshot: async () => (launched ? snapshot : { features: [], agents: [], messages: [] }),
      sendMission: async (text) => {
        assert.equal(text, "Build todo storage");
        await new Promise<void>((done) => {
          resolveLaunch = done;
        });
        launched = true;
      },
    });
    await flush();
    submit(".swarm-launch", "mission", "Build todo storage");
    assert.equal(host.querySelectorAll(".swarm-mission-item").length, 0);
    resolveLaunch();
    await flush();
    button("Database and storage").click();
    assert.equal(host.querySelectorAll(".swarm-mission-item").length, 1);
    assert.match(host.querySelector(".swarm-inspector-metrics")!.textContent!, /2\s*MEMORIES/);
    assert.equal(host.querySelectorAll(".swarm-memory-list li").length, 2);
    assert.match(host.querySelector(".swarm-memory-list")!.textContent!, /Persist todos in SQLite/);
    assert.match(host.textContent!, /assigned team remains responsible/);
    assert.doesNotMatch(host.textContent!, /monitoring is active|PROGRESS/);
    assert.equal(memoryRadius(-10), memoryRadius(0));
    assert.equal(memoryRadius(Number.NaN), memoryRadius(0));
    assert.ok(memoryRadius(2) > memoryRadius(1));
    assert.ok(memoryRadius(100) > memoryRadius(2));
    cleanup();
  });

  await t.test("drag selection requests an actual summary and pan keeps selection", async () => {
    const calls: string[][] = [];
    const cleanup = mountSwarmView(host, {
      loadSnapshot: async () => snapshot,
      summarizeSelection: async (ids) => {
        calls.push(ids);
        return { summary: "The builder finished the SQLite migration; the reviewer is checking stable todo IDs." };
      },
    });
    await flush();
    dragAll();
    assert.equal(host.querySelector(".swarm-inspector h2")?.textContent, "2 agents selected");
    assert.match(host.querySelector(".swarm-group-summary")!.textContent!, /Reading the selected agents/);
    await debounce();
    assert.deepEqual(calls, [["builder", "reviewer"]]);
    assert.match(host.querySelector(".swarm-summary")!.textContent!, /finished the SQLite migration/);
    button("Pan map").click();
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 300, 200);
    pointer("pointerup", 300, 200);
    assert.equal(host.querySelector(".swarm-inspector h2")?.textContent, "2 agents selected");
    button("Zoom in").click();
    assert.equal(host.querySelector(".swarm-map-tools small")?.textContent, "120%");
    button("Refresh").click();
    await flush();
    assert.equal(calls.length, 2);
    cleanup();
  });

  await t.test("changing selection aborts and ignores a stale summary even for the same group", async () => {
    const requests: { resolve: (value: { summary: string }) => void; signal?: AbortSignal }[] = [];
    const cleanup = mountSwarmView(host, {
      loadSnapshot: async () => snapshot,
      summarizeSelection: (_ids, signal) => new Promise((resolve) => requests.push({ resolve, signal })),
    });
    await flush();
    dragAll();
    await debounce();
    button("Database and storage").click();
    assert.equal(requests[0].signal?.aborted, true);
    dragAll();
    await debounce();
    requests[0].resolve({ summary: "Outdated answer" });
    await flush();
    assert.doesNotMatch(host.textContent!, /Outdated answer/);
    requests[1].resolve({ summary: "Current agent overview" });
    await flush();
    assert.match(host.querySelector(".swarm-summary")!.textContent!, /Current agent overview/);
    cleanup();
  });

  await t.test("a failed summary shows an error and retry uses the LLM callback", async () => {
    let calls = 0;
    const cleanup = mountSwarmView(host, {
      loadSnapshot: async () => snapshot,
      summarizeSelection: async () => {
        if (++calls === 1) throw new Error("The summary run failed.");
        return { summary: "The agents are validating persistence." };
      },
    });
    await flush();
    dragAll();
    await debounce();
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /summary run failed/);
    assert.equal(host.querySelector(".swarm-group-summary .swarm-summary"), null);
    button("Try again").click();
    await flush();
    assert.match(host.querySelector(".swarm-summary")!.textContent!, /validating persistence/);
    assert.equal(calls, 2);
    cleanup();
  });

  await t.test("live history deduplicates broadcasts and an agent instruction retains its real target", async () => {
    const sent: { target: SwarmTarget; text: string }[] = [];
    const snapshot: SwarmSnapshot = {
      features: [{ id: "f-1", name: "Live mission", status: "idle", summary: "Agents are ready." }],
      agents: [
        {
          id: "real-agent",
          sessionId: "session/a",
          name: "Live worker",
          role: "Builder",
          state: "idle",
          featureId: "f-1",
        },
      ],
      messages: [
        {
          id: "broadcast-1",
          fromId: "central",
          toId: "real-agent",
          kind: "instruction",
          text: "Check the build",
          createdAt: Date.now(),
        },
        {
          id: "broadcast-1",
          fromId: "central",
          toId: "another-agent",
          kind: "instruction",
          text: "Check the build",
          createdAt: Date.now(),
        },
      ],
    };
    const cleanup = mountSwarmView(host, {
      loadSnapshot: async () => snapshot,
      sendInstruction: async (target, text) => {
        sent.push({ target, text });
      },
    });
    await flush();
    assert.equal(host.querySelectorAll(".swarm-activity-item").length, 1);
    button("Inspect Live worker").click();
    assert.equal(host.querySelector<HTMLAnchorElement>(".swarm-trace-link")?.getAttribute("href"), "/s/session%2Fa");
    submit(".swarm-instruction", "instruction", "Inspect the failing test");
    await flush();
    assert.deepEqual(sent, [{ target: { type: "agent", ids: ["real-agent"] }, text: "Inspect the failing test" }]);
    assert.match(host.querySelector(".swarm-mode-badge")!.textContent!, /LIVE/);
    assert.equal(host.querySelectorAll(".swarm-mission-item").length, 1);
    cleanup();
  });

  await t.test("a late snapshot cannot repopulate an unmounted view", async () => {
    let resolve!: (snapshot: SwarmSnapshot) => void;
    const cleanup = mountSwarmView(host, {
      loadSnapshot: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    cleanup();
    resolve({ features: [], agents: [], messages: [] });
    await flush();
    assert.equal(host.querySelector(".swarm-workspace"), null);
    assert.equal(frames.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal(observers, 0);
  });
});
