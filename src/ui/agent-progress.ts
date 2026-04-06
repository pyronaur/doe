import { formatUsageCompact, type AgentUsageSnapshot } from "../context-usage.js";

type AgentProgressState = "working" | "completed" | "error" | "awaiting_input" | "finalized";
type AgentProgressActivity = string | null | undefined;

export interface AgentProgressShape {
	name: string;
	seatName?: string | null;
	state: AgentProgressState;
	activityLabel?: AgentProgressActivity;
	usage?: AgentUsageSnapshot | null;
	startedAt: number;
	runStartedAt?: number | null;
	completedAt?: number | null;
}

function shouldEllipsizeActivity(label: string): boolean {
	if (!label) return false;
	if (/[.!?…:]$/.test(label)) return false;
	return !label.startsWith("awaiting ") && label !== "completed" && label !== "error";
}

export function formatElapsed(startedAt: number, completedAt?: number | null, now = Date.now()): string {
	const end = completedAt ?? now;
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins >= 60) {
		const hours = Math.floor(mins / 60);
		return `${hours}h ${mins % 60}m`;
	}
	return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export function resolveRunStartedAt(agent: Pick<AgentProgressShape, "startedAt" | "runStartedAt">): number {
	return agent.runStartedAt ?? agent.startedAt;
}

export function formatAgentActivity(agent: Pick<AgentProgressShape, "activityLabel" | "state">): string {
	const label = (agent.activityLabel ?? agent.state).trim();
	return shouldEllipsizeActivity(label) ? `${label}...` : label;
}

export function formatAgentProgressLine(
	agent: AgentProgressShape,
	options: {
		includeName?: boolean;
		now?: number;
	} = {},
): string {
	const includeName = options.includeName ?? true;
	const title = includeName ? `${agent.seatName ?? agent.name} ${formatAgentActivity(agent)}` : formatAgentActivity(agent);
	const usage = formatUsageCompact(agent.usage);
	const meta = [
		usage === "ctx n/a" ? null : usage,
		formatElapsed(resolveRunStartedAt(agent), agent.completedAt ?? null, options.now),
	].filter(Boolean);
	return meta.length > 0 ? `${title} (${meta.join(" - ")})` : title;
}

export function formatAgentProgressSummary(
	agents: AgentProgressShape[],
	options: {
		now?: number;
	} = {},
): string {
	return agents.map((agent) => formatAgentProgressLine(agent, { now: options.now })).join(" | ");
}
