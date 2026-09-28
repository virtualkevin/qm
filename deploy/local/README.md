# Local Docker swarm workspace

QM core, the web surface, Postgres, and agent computers run on the local Docker daemon.
Core and web ports bind to loopback. Postgres and agent workspaces use persistent
Docker volumes. Existing Codex and Memorable sign-in files are mounted read-only;
credentials are never copied into images.

```bash
bash scripts/local-docker.sh
```

Open [the swarm workspace](http://localhost:8765/swarm.html). Every planet and
agent comes from live QM sessions. Launch a feature to dispatch real agents with
`gpt-6-luna` in Fast mode, using your existing Codex sign-in. The core API is at
<http://localhost:8766>.

The current workspace builds a todo app. Its feature planets share one actual
sandbox workspace and retain their agents and conversation history. Open
[the todo app](http://localhost:8768) to exercise their changes. The todo server
uses the shared sandbox volume and reloads server changes automatically.

Restart the existing todo app with its saved workspace volume:

```bash
docker compose --env-file deploy/local/todo.env -f deploy/local/compose.todo.yaml up -d
```

For the demo, open the todo app, then dispatch **Add todo list reordering** from
the swarm workspace. Watch the feature agents edit the shared app and verify
the result. Drag across agents to select them: the inspector requests a real
LLM overview of their recent session messages. Select a feature planet and send
an issue or follow-up to its existing owners to resume their work. Ownership is
durable; continuous background monitoring is not configured.

Save the current demo state once agents have finished:

```bash
node scripts/demo-checkpoint.mjs save demo-baseline
node scripts/demo-checkpoint.mjs verify demo-baseline
```

Replay the demo, then reset its sessions, agents, memories, todo data, and sandbox
workspaces to that saved state:

```bash
node scripts/demo-checkpoint.mjs restore demo-baseline
```

Checkpoints include the complete QM Postgres database, core data volume, all
local sandbox volumes discoverable from their containers, the shared todo volume,
and the local encryption and signing configuration. Save and restore refuse queued
or running agents and briefly stop the demo and sandbox containers. Save restarts
all containers that were running; restore restarts the demo services and lets QM
start retained sandboxes on demand. Avoid launching work while either command runs.
Restore verifies every archive first and saves the current state in a separate
`before-restore-*` checkpoint before changing it. It also retains the previous
database under a `qm_demo_before_*` name. Sandbox volumes created after the baseline
are preserved; their later sessions disappear from the restored database.

Snapshots live only in `deploy/local/checkpoints/`, excluded from Git and Docker
build contexts. They contain credentials and private conversations: keep this
directory on your machine. Directories are private to your user and snapshot files
are mode `0600`. Your host Codex and Memorable sign-ins are still required and are
not included. The checkpoint records the Git commit but does not switch source
code; use the saved demo branch for the same UI and runtime behavior. If a restore
fails after it starts changing data, services stay stopped and the command prints
the recovery checkpoint name. Restore that checkpoint before resuming the demo.
After recovery, start services with `docker compose -f deploy/local/compose.yaml up -d`
and the todo restart command above.

## OrbStack network capacity

Each agent sandbox has its own isolated Docker network. Demo resets preserve those
networks, so repeated demos can exhaust the available subnets and fail with
`all predefined address pools have been fully subnetted`.

On OrbStack, run `orb config docker` to edit `~/.orbstack/config/docker.json`.
Saving changes restarts the Docker engine, so let active agents finish first.
Merge this setting into the configuration. If `default-address-pools` already
exists, append the new pool; preserve all other settings, existing pools, and
IPv6 entries:

```json
{
  "default-address-pools": [{ "base": "10.240.0.0/14", "size": 24 }]
}
```

This adds capacity for 1,024 `/24` networks. Check that the range does not overlap
your LAN or VPN routes before using it. Verify the applied pools with:

```bash
docker info --format '{{json .DefaultAddressPools}}'
```

This configuration is local to your machine; restoring a demo checkpoint does
not change it. Increasing capacity preserves the existing networks and data;
global pruning or deleting volumes is unnecessary. See Docker's
[automatic subnet allocation](https://docs.docker.com/engine/network/#automatic-subnet-allocation)
documentation for pool sizing.

Planet size follows the number of actual Memorable procedure records associated
with its agents' sessions. After feature workers finish, the UI asks QM to extract
procedures from their stored tool traces through Memorable. No procedures or
counts are seeded. Memorable stores its procedure records in local QM Postgres;
its authenticated extraction service processes the tool traces. Future agents
recall relevant procedures through QM's existing memory provider.

The default credential files are `~/.codex/auth.json` and
`~/.memorable/config.json`. Set `CODEX_AUTH_FILE` or `MEMORABLE_CONFIG_FILE` to
reuse alternate existing sign-ins. The launcher enables Memorable capture and
recall for the local `dev` user's scope. Internal signing and encryption keys
live in the ignored `deploy/local/local.env`; preserve it with the data volumes.

Frontend source updates through Vite. Once active agents have finished, load
backend changes with:

```bash
docker compose -f deploy/local/compose.yaml restart core web
docker compose -f deploy/local/compose.yaml logs --tail 100 core web
```

Stop services while preserving their data:

```bash
docker compose --env-file deploy/local/todo.env -f deploy/local/compose.todo.yaml down
docker compose -f deploy/local/compose.yaml down
```

Agent computers are separate Docker containers labeled `qm.org=local`. Keep
their volumes to preserve feature workspaces. This stack is for a trusted local
machine: QM core controls the local Docker daemon.
