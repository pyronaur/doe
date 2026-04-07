import { isUsageSnapshotStale, type AgentCompactionState, type AgentUsageSnapshot } from "./context-usage.js";

export interface AgentCapacityShape {
	usage?: AgentUsageSnapshot | null;
	compaction?: AgentCompactionState | null;
	recovered?: boolean | null;
}

export function formatAgentCapacity(input: AgentCapacityShape): string {
	const usedPercent = input.usage?.usedPercent;
	if (input.recovered) return "?";
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "?";
	if (isUsageSnapshotStale(input.usage ?? null, input.compaction ?? null)) return "?";
	return `${usedPercent}%`;
}
