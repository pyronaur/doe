import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { truncateForDisplay } from "../codex/client.ts";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.ts";
import { SEAT_ROLE_LABELS, SEAT_ROLES } from "../roster/config.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import type { RosterAssignmentRecord } from "../roster/types.ts";

const StateSchema = StringEnum(
	["working", "completed", "error", "awaiting_input", "finalized"] as const,
);

const LIST_TOOL_META = {
	name: "codex_list",
	label: "Codex List",
	description:
		"List the active DOE roster by named IC. Legacy agent-centric filters remain available for debug use.",
	promptSnippet:
		"List active DOE ICs to find the right seat before resuming, inspecting, cancelling, or finalizing.",
	promptGuidelines: [
		"Default output shows occupied ICs: working, awaiting_input, and completed-but-not-finalized seats.",
		"Set includeAwaitingInput=false only when you explicitly want to hide waiting seats.",
		"Set includeHistory=true to also include released seat history beyond currently occupied seats.",
		"Use includeIds=true only when raw agentId/threadId details are actually needed.",
	],
	parameters: Type.Object({
		state: Type.Optional(StateSchema),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		includeCompleted: Type.Optional(Type.Boolean()),
		includeBatches: Type.Optional(Type.Boolean()),
		includeAwaitingInput: Type.Optional(Type.Boolean()),
		includeHistory: Type.Optional(Type.Boolean()),
		includeIds: Type.Optional(Type.Boolean()),
	}),
} as const;

function formatRosterEntry(entry: RosterAssignmentRecord, includeIds: boolean): string {
	const { agent, seat, source } = entry;
	const compaction = formatCompactionSignal(agent.compaction);
	const parts = [
		`- ${seat.name} [${agent.state}] ${agent.model}`,
		`mode=${agent.allowWrite ? "write" : "read-only"}`,
		formatUsageCompact(agent.usage),
	];
	if (compaction) {
		parts.push(compaction);
	}
	if (source === "history") {
		parts.push("history");
	}
	let line = `${parts.join(" ")} latest=${
		truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 120)
	}`;
	if (includeIds) {
		line = `${line} agentId=${agent.id}${agent.threadId ? ` threadId=${agent.threadId}` : ""}`;
	}
	return line;
}

function buildStateListing(
	registry: DoeRegistry,
	params: {
		state: string;
		limit?: number;
		includeCompleted?: boolean;
		includeBatches?: boolean;
	},
) {
	const agents = registry.listAgents({
		state: params.state,
		limit: params.limit ?? 12,
		includeCompleted: params.includeCompleted ?? true,
	});
	const batches = params.includeBatches ? registry.listBatches(12) : [];
	const lines = agents.length
		? agents.map((agent) => {
			const compaction = formatCompactionSignal(agent.compaction);
			return `- ${agent.id} :: ${agent.name} [${agent.state}] ${agent.model} mode=${
				agent.allowWrite ? "write" : "read-only"
			} ${formatUsageCompact(agent.usage)}${
				compaction ? ` ${compaction}` : ""
			} cwd=${agent.cwd} latest=${
				truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 120)
			}`;
		})
		: ["No matching agents."];
	if (batches.length > 0) {
		lines.push("", "Batches:");
		for (const batch of batches) {
			lines.push(
				`- ${batch.id} :: ${batch.name} agents=${batch.agentIds.length} state=${
					batch.completedAt ? "completed" : "working"
				}`,
			);
		}
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { agents, batches },
	};
}

function buildRosterListing(
	registry: DoeRegistry,
	params: {
		includeAwaitingInput?: boolean;
		includeHistory?: boolean;
		limit?: number;
		includeBatches?: boolean;
		includeIds?: boolean;
	},
) {
	const roster = registry.listRosterAssignments({
		includeAwaitingInput: params.includeAwaitingInput ?? true,
		includeHistory: params.includeHistory ?? false,
		limit: params.limit,
	});
	const summaries = registry.getRosterRoleSummaries({
		includeAwaitingInput: params.includeAwaitingInput ?? true,
		includeHistory: params.includeHistory ?? false,
	});
	const countLabel = params.includeHistory || params.includeAwaitingInput === false
		? "visible"
		: "occupied";
	const includeIds = params.includeIds ?? false;
	const lines: string[] = [
		`${countLabel}: ${roster.length}`,
		...summaries.map((entry) =>
			`${SEAT_ROLE_LABELS[entry.role]}: ${entry.activeCount}${
				entry.names.length ? ` (${entry.names.join(", ")})` : ""
			}`
		),
	];

	if (roster.length === 0) {
		lines.push("", "No matching ICs.");
	}
	for (const role of SEAT_ROLES) {
		const entries = roster.filter((entry) => entry.seat.role === role);
		if (entries.length === 0) {
			continue;
		}
		lines.push("", `${SEAT_ROLE_LABELS[role]}:`);
		for (const entry of entries) {
			lines.push(formatRosterEntry(entry, includeIds));
		}
	}

	if (params.includeBatches) {
		const batches = registry.listBatches(12);
		if (batches.length > 0) {
			lines.push("", "Batches:");
			for (const batch of batches) {
				lines.push(
					`- ${batch.name} agents=${batch.agentIds.length} state=${
						batch.completedAt ? "completed" : "working"
					}`,
				);
			}
		}
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { roster, summaries },
	};
}

function createListTool(deps: { registry: DoeRegistry }) {
	return {
		...LIST_TOOL_META,
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "codex_list"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", "codex_list") + "\n" + (result.content?.[0]?.text ?? ""),
				0, 0);
		},
		async execute(_toolCallId, params) {
			if (params.state) {
				return buildStateListing(deps.registry, params);
			}
			return buildRosterListing(deps.registry, params);
		},
	};
}

export function registerListTool(pi: ExtensionAPI, deps: { registry: DoeRegistry }) {
	pi.registerTool(createListTool(deps));
}
