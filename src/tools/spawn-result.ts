import { formatAgentCapacity } from "../agent-capacity.ts";
import { truncateForDisplay } from "../codex/client.ts";
import { formatContextStatusLines } from "./context-status.ts";

interface SpawnResultMessage {
	content?: Array<{ type?: string; text?: string }>;
	details?: {
		agents?: any[];
		promptsByAgentId?: Record<string, string>;
	};
}

function stripSharedSessionContext(prompt: string): string {
	const normalized = prompt.replace(/\r\n?/g, "\n").trim();
	if (!normalized.startsWith("Shared session context:")) {
		return normalized;
	}
	const lines = normalized.split("\n");
	if (lines[0]?.trim() !== "Shared session context:") {
		return normalized;
	}
	let index = 1;
	while (index < lines.length && lines[index].trim() !== "") {
		index += 1;
	}
	while (index < lines.length && lines[index].trim() === "") {
		index += 1;
	}
	const stripped = lines.slice(index).join("\n").trim();
	return stripped || normalized;
}

function summarizeAgents(agents: Array<any>, maxSnippet = 120): string {
	return agents
		.map((agent) =>
			`${`- ${agent.name} [${agent.state}] ${agent.model} ${formatAgentCapacity(agent)}`} — ${
				truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, maxSnippet)
			}`
		)
		.join("\n");
}

export function formatSpawnAgentResult(agent: any, input: { prompt?: string | null } = {}): string {
	const prompt = input.prompt ? stripSharedSessionContext(input.prompt) : "(prompt unavailable)";
	return [
		`ic: ${agent.name}`,
		`agent_id: ${agent.id ?? "unknown"}`,
		`thread_id: ${agent.threadId ?? "pending"}`,
		`state: ${agent.state}`,
		`capacity: ${formatAgentCapacity(agent)}`,
		`model: ${agent.model}`,
		`effort: ${agent.effort ?? "?"}`,
		...formatContextStatusLines(agent.compaction),
		"",
		"prompt:",
		prompt,
		"",
		"next_step:",
		"Worker launched and running in the background. Use codex_resume to steer, and use codex_list or codex_inspect to monitor progress.",
	].join("\n");
}

export function formatSpawnBatchResults(
	agents: any[],
	promptsByAgentId: Record<string, string> = {},
): string {
	const header = [
		`batch_status: working`,
		`batch_size: ${agents.length}`,
		"next_step: Use codex_resume to steer running workers, and codex_list or codex_inspect to monitor progress.",
	];
	const body = agents
		.map((agent, index) =>
			[
				`## ${index + 1}. ${agent.name}`,
				formatSpawnAgentResult(agent, { prompt: promptsByAgentId[agent.id] ?? null }),
			].join("\n")
		)
		.join("\n\n---\n\n");
	return `${header.join("\n")}\n\n${body}`;
}

export function resolveSpawnRenderBody(result: SpawnResultMessage): string {
	const text = result.content?.find((entry) =>
		entry.type === "text" && typeof entry.text === "string"
	)?.text?.trim();
	if (text) { return text; }
	const agents = Array.isArray(result.details?.agents) ? result.details?.agents : [];
	return agents.length > 0 ? summarizeAgents(agents) : "Spawned";
}
