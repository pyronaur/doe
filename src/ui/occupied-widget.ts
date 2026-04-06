import type { DoeRegistry } from "../state/registry.js";
import { formatAgentProgressLine } from "./agent-progress.js";

export function formatOccupiedWidget(registry: DoeRegistry, monitorShortcut: string): string[] {
	const roster = registry.listRosterAssignments();
	if (roster.length === 0) return [];
	if (roster.some((entry) => entry.agent.state === "working")) return [];

	const summaries = registry.getRosterBucketSummaries();
	return [
		`DoE Occupied Roster (${roster.length})`,
		...summaries
			.filter((entry) => entry.activeCount > 0)
			.map((entry) => `${entry.label}: ${entry.names.join(", ")}`),
		...roster.map(({ agent }, index) => `${index + 1}. ${formatAgentProgressLine(agent)}`),
		`${monitorShortcut} monitor`,
	];
}
