import { formatAgentCapacity } from "../agent-capacity.ts";
import type { DoeRegistry } from "../roster/registry.ts";

function formatState(state: string): string {
	if (state === "working") { return "work"; }
	if (state === "awaiting_input") { return "wait"; }
	if (state === "completed") { return "done"; }
	if (state === "error") { return "error"; }
	return "final";
}

export function formatDoeStatus(registry: DoeRegistry): string {
	const roster = registry.listRosterAssignments();
	const occupied = roster.length;
	const label = `${occupied} Occupied IC${occupied === 1 ? "" : "s"}`;
	if (occupied === 0) { return label; }

	const summary = roster
		.map((entry) =>
			`${entry.seat.name}[${formatState(entry.agent.state)} ${formatAgentCapacity(entry.agent)}]`
		)
		.join(" | ");

	return `${label}: ${summary}`;
}
