import { truncateForDisplay } from "../codex/client.js";
import { formatCompactionSignal } from "../context-usage.js";
import { formatAgentCapacity } from "../agent-capacity.js";

interface SpawnResultMessage {
	content?: Array<{ type?: string; text?: string }>;
	details?: {
		agents?: any[];
		promptsByAgentId?: Record<string, string>;
	};
}

function summarizeAgents(agents: Array<any>, maxSnippet = 120): string {
	return agents
		.map((agent) => `${`- ${agent.name} [${agent.state}] ${agent.model} ${formatAgentCapacity(agent)}`} — ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, maxSnippet)}`)
		.join("\n");
}

function resolveAgentFinalOutput(agent: any): string {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) => message?.role === "agent" && typeof message?.text === "string" && message.text.trim().length > 0)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? "Completed";
}

export function formatSpawnAgentResult(agent: any, input: { prompt?: string | null } = {}): string {
	const prompt = input.prompt?.trim() || "(prompt unavailable)";
	return [
		`ic: ${agent.name}`,
		`state: ${agent.state}`,
		`capacity: ${formatAgentCapacity(agent)}`,
		`model: ${agent.model}`,
		`effort: ${agent.effort ?? "?"}`,
		...(formatCompactionSignal(agent.compaction) ? [`context_status: ${formatCompactionSignal(agent.compaction)}`] : []),
		"",
		"prompt:",
		prompt,
		"",
		"result:",
		resolveAgentFinalOutput(agent),
	].join("\n");
}

export function formatSpawnBatchResults(agents: any[], promptsByAgentId: Record<string, string> = {}): string {
	return agents
		.map((agent, index) => [`## ${index + 1}. ${agent.name}`, formatSpawnAgentResult(agent, { prompt: promptsByAgentId[agent.id] ?? null })].join("\n"))
		.join("\n\n---\n\n");
}

export function resolveSpawnRenderBody(result: SpawnResultMessage): string {
	const text = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text?.trim();
	if (text) return text;
	const agents = Array.isArray(result.details?.agents) ? result.details?.agents : [];
	return agents.length > 0 ? summarizeAgents(agents) : "Spawned";
}
