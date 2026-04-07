import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import { formatUsageCompact } from "../context-usage.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { cancelAgentRun } from "./cancel-agent-run.ts";
import { formatContextStatusLines } from "./context-status.ts";
import { resolveSeatTarget } from "./resume-target.ts";
import { AgentLookupFields } from "./shared-schemas.ts";

export function registerCancelTool(
	pi: ExtensionAPI,
	deps: { registry: DoeRegistry; client: CodexAppServerClient },
) {
	pi.registerTool({
		name: "codex_cancel",
		label: "Codex Cancel",
		description: "Cancel an in-flight Codex worker by IC seat, agentId, or threadId.",
		promptSnippet: "Cancel a specific worker when the user wants it stopped.",
		promptGuidelines: [
			"Prefer ic for named-seat lookup. agentId and threadId remain available for legacy/debug use.",
			"Interrupts the active turn if one exists, unsubscribes the thread, and releases the seat.",
			"Use codex_resume with reuseFinished=true only when DOE explicitly wants to reopen the canceled thread context.",
		],
		parameters: Type.Object({
			...AgentLookupFields,
		}),
		renderCall(args, theme) {
			return new Text(
				theme.fg("warning", `codex_cancel ${args.ic ?? args.agentId ?? args.threadId ?? "thread"}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("warning", result.content?.[0]?.text ?? "Cancelled"), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agent = resolveSeatTarget(deps.registry, params, {
				includeFinished: false,
				missingSeatMessage: (ic) => `${ic} has no active assignment to cancel.`,
			});
			if (!agent?.threadId) { throw new Error("Unknown IC/agent/thread."); }
			const updated = await cancelAgentRun({
				agent,
				client: deps.client,
				registry: deps.registry,
				note: "Cancelled by Director of Engineering.",
			});
			return {
				content: [{
					type: "text",
					text: [
						`Cancelled ${agent.name}.`,
						"state: finalized",
						"seat: released",
						`context: ${formatUsageCompact(updated?.usage)}`,
						...formatContextStatusLines(updated?.compaction),
					].join("\n"),
				}],
				details: { agent: updated },
			};
		},
	});
}
