import type { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";

interface AttachSeatAgentInput {
	agentId: string;
	ic: string;
	state?: AgentRecord["state"];
	threadId?: string;
	agent?: Partial<AgentRecord>;
}

export function createRegistryAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "agent-1",
		name: "Agent 1",
		cwd: "/tmp",
		model: "gpt-5.4",
		state: "working",
		latestSnippet: "",
		latestFinalOutput: null,
		lastError: null,
		startedAt: 1,
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		messages: [],
		historyHydratedAt: null,
		...overrides,
	};
}

export function attachSeatAgent(registry: DoeRegistry, input: AttachSeatAgentInput) {
	const seat = registry.assignSeat({ agentId: input.agentId, ic: input.ic });
	registry.upsertAgent(
		createRegistryAgent({
			id: input.agentId,
			name: seat.name,
			threadId: input.threadId ?? `${input.agentId}-thread`,
			state: input.state ?? "working",
			seatName: seat.name,
			seatRole: seat.role,
			...input.agent,
		}),
	);
	return seat;
}

export function requireRegistryAgent(registry: DoeRegistry, id: string): AgentRecord {
	const agent = registry.getAgent(id);
	if (!agent) {
		throw new Error(`Agent "${id}" not found.`);
	}
	return agent;
}
