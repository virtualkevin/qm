import { api } from "./core-bridge";
import { mountSwarmWorkspace } from "./swarm-workspace";

const host = document.getElementById("swarm-demo");
if (!host) throw new Error("missing swarm host");
api<{ user: string }>("/me")
  .then(({ user }) => {
    const dispose = mountSwarmWorkspace(host, user);
    window.addEventListener("pagehide", dispose, { once: true });
  })
  .catch((error: unknown) => {
    host.textContent = error instanceof Error ? error.message : "Could not connect to local QM";
  });
