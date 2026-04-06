import type { AgentRecord, DoeRegistry } from "../state/registry.js";
import { formatAgentProgressSummary } from "../ui/agent-progress.js";

function collectAgents(registry: DoeRegistry, agentIds: string[]): AgentRecord[] {
	return agentIds
		.map((agentId) => registry.getAgent(agentId))
		.filter((agent): agent is AgentRecord => Boolean(agent));
}

function activeAgents(agents: AgentRecord[]): AgentRecord[] {
	return agents.filter((agent) => agent.state === "working");
}

export function buildToolProgressUpdate(registry: DoeRegistry, agentIds: string[]): {
	agents: AgentRecord[];
	activeAgents: AgentRecord[];
	progressSummary: string;
} {
	const agents = collectAgents(registry, agentIds);
	const working = activeAgents(agents);
	const summaryAgents = working.length > 0 ? working : agents;
	return {
		agents,
		activeAgents: working,
		progressSummary: summaryAgents.length > 0 ? formatAgentProgressSummary(summaryAgents) : "Launching ICs...",
	};
}

export function readToolProgressSummary(result: any): string | null {
	const summary = result?.details?.progressSummary;
	return typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : null;
}

export function startToolProgressUpdates(input: {
	registry: DoeRegistry;
	agentIds: string[];
	onUpdate?: ((update: any) => void) | undefined;
	baseDetails?: Record<string, unknown>;
}): () => void {
	if (!input.onUpdate) return () => {};
	let lastSummary: string | null = null;

	const emitProgress = () => {
		const snapshot = buildToolProgressUpdate(input.registry, input.agentIds);
		if (snapshot.progressSummary === lastSummary) return;
		lastSummary = snapshot.progressSummary;
		input.onUpdate?.({
			content: [{ type: "text", text: snapshot.progressSummary }],
			details: {
				...(input.baseDetails ?? {}),
				agentIds: [...input.agentIds],
				agents: snapshot.agents,
				activeAgents: snapshot.activeAgents,
				progressSummary: snapshot.progressSummary,
			},
		});
	};

	const handleEvent = () => emitProgress();
	input.registry.on("event", handleEvent);
	emitProgress();

	return () => {
		input.registry.off("event", handleEvent);
	};
}
