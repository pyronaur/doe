import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatUsageCompact } from "../context-usage.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { formatContextStatusLines } from "./context-status.ts";
import { renderToolResultText } from "./tool-render.ts";

export function registerFinalizeTool(pi: ExtensionAPI, deps: { registry: DoeRegistry }) {
	pi.registerTool({
		name: "codex_finalize",
		label: "Codex Finalize",
		description:
			"Finalize a named IC seat after non-working work is done and the seat should be released.",
		promptSnippet:
			"Finalize a named IC seat when a completed or awaiting-input assignment is done and the seat should be released.",
		promptGuidelines: [
			"Requires ic. This is a named-seat operation.",
			"Use only after the assignment is no longer actively running.",
			"Use note and reuseSummary only when DOE explicitly wants them persisted.",
			"Do not use this as a substitute for codex_cancel.",
		],
		parameters: Type.Object({
			ic: Type.String(),
			note: Type.Optional(Type.String()),
			reuseSummary: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_finalize ${args.ic}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderToolResultText(theme, result, "Finalized");
		},
		async execute(_toolCallId, params) {
			const { seat, agent } = deps.registry.finalizeSeat(params.ic, {
				note: params.note ?? null,
				reuseSummary: params.reuseSummary ?? null,
			});
			return {
				content: [{
					type: "text",
					text: [
						`ic: ${seat.name}`,
						"state: finalized",
						`context: ${formatUsageCompact(agent.usage)}`,
						...formatContextStatusLines(agent.compaction),
						...(seat.lastFinishNote ? [`finish_note: ${seat.lastFinishNote}`] : []),
						...(seat.lastReuseSummary ? [`reuse_summary: ${seat.lastReuseSummary}`] : []),
					].join("\n"),
				}],
				details: { seat, agent },
			};
		},
	});
}
