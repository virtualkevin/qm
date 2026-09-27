import { appState } from "./shell";
import { mountSwarmWorkspace } from "./swarm-workspace";

let dispose: (() => void) | undefined;

export function stopSwarm(): void {
  dispose?.();
  dispose = undefined;
}

export function renderSwarm(): void {
  stopSwarm();
  if (!appState.mainEl || appState.currentView !== "swarm") return;
  dispose = mountSwarmWorkspace(appState.mainEl, appState.me?.user ?? "local");
}
