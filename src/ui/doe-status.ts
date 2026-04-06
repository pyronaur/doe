import type { DoeRegistry } from "../state/registry.js";

export function formatDoeStatus(registry: DoeRegistry): string {
	const roster = registry.listRosterAssignments();
	const active = roster.length;
	const label = `${active} Active IC${active === 1 ? "" : "s"}`;
	if (active === 0) return label;

	const summary = [
		...roster.filter((entry) => entry.agent.state === "working"),
		...roster.filter((entry) => entry.agent.state !== "working"),
	]
		.filter((entry, index, items) => items.findIndex((candidate) => candidate.agent.id === entry.agent.id) === index)
		.filter((entry) => typeof entry.agent.usage?.usedPercent === "number")
		.slice(0, 2)
		.map((entry) => `${entry.seat.name} (${entry.agent.usage!.usedPercent}%)`)
		.join(", ");

	return summary ? `${label}: ${summary}` : label;
}
