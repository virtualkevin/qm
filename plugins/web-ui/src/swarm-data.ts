import type { SwarmInspection, SwarmMember, SwarmMessage } from "./swarm-api";
import type { SwarmSnapshot } from "./swarm-view";
import type { CoreSession } from "./core-bridge";

function contextText(member: SwarmMember, ...keys: string[]): string | undefined {
  const context = member.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
  const values = context as Record<string, unknown>;
  return keys.map((key) => values[key]).find((value): value is string => typeof value === "string" && !!value.trim());
}

const memberStates = { reserved: "traveling", ready: "idle", failed: "blocked" } as const;
const activityLabels = {
  idle: "Ready",
  traveling: "Provisioning a computer",
  blocked: "Waiting for input",
  working: "Working",
  returning: "Returning",
};

type SessionActivity = Pick<CoreSession, "id" | "working" | "awaitingInput">;

function agentState(member: SwarmMember, session?: SessionActivity): SwarmSnapshot["agents"][number]["state"] {
  if (member.state !== "ready") return memberStates[member.state];
  if (session?.awaitingInput) return "blocked";
  if (session?.working) return "working";
  return "idle";
}

export function swarmSnapshot(
  inspection: SwarmInspection,
  messages: readonly SwarmMessage[],
  sessions: readonly SessionActivity[] = [],
): SwarmSnapshot {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const activity = (member: SwarmMember) => sessionById.get(member.sessionId ?? "");
  const memberById = new Map(inspection.peers.map((member) => [member.id, member]));
  const planetName = (member: SwarmMember): string => {
    const visited = new Set<string>();
    let current: SwarmMember | undefined = member;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const name = contextText(current, "group", "feature", "featureId");
      if (name) return name;
      current = current.parentId ? memberById.get(current.parentId) : undefined;
    }
    return "Worker pool";
  };
  const groups = new Map<string, { name: string; members: SwarmMember[] }>();
  const featureByMember = new Map<string, string>();
  for (const member of inspection.peers) {
    if (!member.parentId) continue;
    const name = planetName(member);
    const id = `feature:${name}`;
    const group = groups.get(id) ?? { name, members: [] };
    group.members.push(member);
    groups.set(id, group);
    featureByMember.set(member.id, id);
  }
  return {
    features: [...groups].map(([id, group]) => {
      const ready = group.members.filter((member) => agentState(member, activity(member)) === "idle").length;
      const working = group.members.filter((member) => agentState(member, activity(member)) === "working").length;
      const waiting = group.members.filter(
        (member) => member.state === "ready" && activity(member)?.awaitingInput,
      ).length;
      const reserved = group.members.filter((member) => member.state === "reserved").length;
      const failed = group.members.filter((member) => member.state === "failed").length;
      const counts: Array<[number, string]> = [
        [working, "working"],
        [ready, "ready"],
        [waiting, "awaiting input"],
        [reserved, "provisioning"],
        [failed, "failed"],
      ];
      let status: SwarmSnapshot["features"][number]["status"] = "idle";
      if (working || reserved) status = "active";
      if (failed || waiting) status = "blocked";
      const ownership = group.members.map((member) => contextText(member, "ownership")).find(Boolean);
      return {
        id,
        name: group.name,
        status,
        ...(ownership ? { ownership } : {}),
        summary: counts
          .filter(([count]) => count > 0)
          .map(([count, label]) => `${count} ${label}`)
          .join(" · "),
      };
    }),
    agents: inspection.peers.map((member, index) => {
      const latest = messages.findLast((message) => message.senderId === member.id && message.author === "agent");
      const state = agentState(member, activity(member));
      return {
        id: member.id,
        sessionId: member.sessionId,
        name: contextText(member, "name") ?? (member.parentId ? `Agent ${index + 1}` : "Coordinator"),
        role: contextText(member, "role") ?? (member.parentId ? "Worker" : "Coordinator"),
        state,
        featureId: featureByMember.get(member.id),
        task: contextText(member, "task", "goal", "mission"),
        summary: member.error ?? latest?.text ?? activityLabels[state],
      };
    }),
    messages: messages.toReversed().flatMap((message) =>
      (message.audience.length ? message.audience : [""]).map((recipientId) => ({
        id: message.id,
        fromId: message.senderId,
        toId: recipientId,
        kind: message.author === "human" ? "instruction" : "status",
        text: message.text,
        createdAt: message.createdAt,
      })),
    ),
  };
}
