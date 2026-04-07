import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import type { DoeRegistry } from "../roster/registry.js";
import { cancelAgentRun } from "./cancel-agent-run.js";

function resolveCancelTarget(registry: DoeRegistry, params: any) {
	if (params.ic) {
		const active = registry.findActiveSeatAgent(params.ic);
		if (active) return active;
		if (registry.findSeat(params.ic)) {
			throw new Error(`${params.ic} has no active assignment to cancel.`);
		}
	}
	if (params.agentId) return registry.findAgent(params.agentId);
	if (params.threadId) return registry.findAgent(params.threadId);
	return undefined;
}

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
			ic: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("warning", `codex_cancel ${(args as any).ic ?? (args as any).agentId ?? (args as any).threadId ?? "thread"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("warning", result.content?.[0]?.text ?? "Cancelled"), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agent = resolveCancelTarget(deps.registry, params);
			if (!agent?.threadId) throw new Error("Unknown IC/agent/thread.");
			const updated = await cancelAgentRun({
				agent,
				client: deps.client,
				registry: deps.registry,
				note: "Cancelled by Director of Engineering.",
			});
			return {
				content: [{ type: "text", text: `Cancelled ${agent.name}.\nstate: finalized\nseat: released\ncontext: ${formatUsageCompact(updated?.usage)}${formatCompactionSignal(updated?.compaction) ? `\ncontext_status: ${formatCompactionSignal(updated?.compaction)}` : ""}` }],
				details: { agent: updated },
			};
		},
	});
}
