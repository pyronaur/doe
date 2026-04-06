import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DoeRegistry } from "../state/registry.js";
import { truncateForDisplay } from "../codex/client.js";

const StateSchema = StringEnum(["working", "completed", "error", "awaiting_input"] as const);

export function registerListTool(pi: ExtensionAPI, deps: { registry: DoeRegistry }) {
	pi.registerTool({
		name: "codex_list",
		label: "Codex List",
		description: "List active and recent Codex workstreams with their agentIds.",
		promptSnippet: "List recent workstreams to find an agentId before resuming or inspecting.",
		promptGuidelines: [
			"Use before resuming when the right thread isn't obvious.",
			"Output includes agentIds — pass these to codex_resume or codex_inspect.",
		],
		parameters: Type.Object({
			state: Type.Optional(StateSchema),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
			includeCompleted: Type.Optional(Type.Boolean()),
			includeBatches: Type.Optional(Type.Boolean()),
		}),
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "codex_list"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", "codex_list") + "\n" + (result.content?.[0]?.text ?? ""), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agents = deps.registry.listAgents({
				state: params.state as any,
				limit: params.limit ?? 12,
				includeCompleted: params.includeCompleted ?? true,
			});
			const batches = params.includeBatches ? deps.registry.listBatches(12) : [];
			const lines = agents.length
				? agents.map(
					(agent) =>
						`- ${agent.id} :: ${agent.name} [${agent.state}] ${agent.model} mode=${agent.allowWrite ? "write" : "read-only"} cwd=${agent.cwd} latest=${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 120)}`,
				)
				: ["No matching agents."];
			if (batches.length > 0) {
				lines.push("", "Batches:");
				for (const batch of batches) {
					lines.push(`- ${batch.id} :: ${batch.name} agents=${batch.agentIds.length} state=${batch.completedAt ? "completed" : "working"}`);
				}
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { agents, batches },
			};
		},
	});
}
