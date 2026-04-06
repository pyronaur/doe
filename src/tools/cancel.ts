import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import type { DoeRegistry } from "../state/registry.js";

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
			"Interrupts the active turn if one exists. Errors if no active match is found.",
			"Do not use to cancel an idle thread just to spawn fresh — use codex_spawn directly instead.",
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
			if (agent.activeTurnId) {
				await deps.client.interruptTurn(agent.threadId, agent.activeTurnId);
			}
			deps.registry.markAwaitingInput(agent.threadId, "Interrupted by Director of Engineering.");
			const updated = deps.registry.getAgent(agent.id);
			return {
				content: [{ type: "text", text: `Interrupted ${agent.name}.\ncontext: ${formatUsageCompact(updated?.usage)}${formatCompactionSignal(updated?.compaction) ? `\ncontext_status: ${formatCompactionSignal(updated?.compaction)}` : ""}` }],
				details: { agent: updated },
			};
		},
	});
}
