import type { DoeRegistry } from "../state/registry.js";
import { formatAgentProgressLine } from "./agent-progress.js";

const CANCELLED_SIGNALS = [
	"interrupted by director of engineering",
	"operation aborted",
	"cancelled",
	"canceled",
] as const;

function isCancelledLike(text: string | null | undefined): boolean {
	if (!text) return false;
	const normalized = text.trim().toLowerCase();
	if (!normalized) return false;
	return CANCELLED_SIGNALS.some((signal) => normalized.includes(signal));
}

export function formatOccupiedWidget(registry: DoeRegistry, monitorShortcut: string): string[] {
	const roster = registry
		.listRosterAssignments()
		.filter((entry) => ![entry.agent.latestFinalOutput, entry.agent.latestSnippet, entry.agent.lastError].some(isCancelledLike));
	if (roster.length === 0) return [];
	if (roster.some((entry) => entry.agent.state === "working")) return [];

	const summaries = new Map<string, { label: string; names: string[] }>();
	for (const entry of roster) {
		const current = summaries.get(entry.seat.bucket) ?? { label: entry.seat.bucket, names: [] };
		current.label = entry.seat.bucket === "senior"
			? "Senior Engineers"
			: entry.seat.bucket === "mid"
				? "Mid-level Engineers"
				: entry.seat.bucket === "research"
					? "Researchers/Assistants"
					: "Contractors";
		current.names.push(entry.seat.name);
		summaries.set(entry.seat.bucket, current);
	}
	return [
		`DoE Occupied Roster (${roster.length})`,
		...[...summaries.values()].map((entry) => `${entry.label}: ${entry.names.join(", ")}`),
		...roster.map(({ agent }, index) => `${index + 1}. ${formatAgentProgressLine(agent)}`),
		`${monitorShortcut} monitor`,
	];
}
