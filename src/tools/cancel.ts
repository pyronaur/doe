import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import type { DoeRegistry } from "../state/registry.js";

export function registerCancelTool(
	pi: ExtensionAPI,
	deps: { registry: DoeRegistry; client: CodexAppServerClient },
) {
	pi.registerTool({
		name: "codex_cancel",
		label: "Codex Cancel",
		description: "Interrupt an in-flight Codex turn for registry hygiene or user control.",
		promptSnippet: "Interrupt an in-flight Codex worker when the user wants to stop it.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("warning", `codex_cancel ${(args as any).agentId ?? (args as any).threadId ?? "thread"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("warning", result.content?.[0]?.text ?? "Cancelled"), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agent = params.agentId
				? deps.registry.findAgent(params.agentId)
				: params.threadId
					? deps.registry.findAgent(params.threadId)
					: undefined;
			if (!agent?.threadId) throw new Error("Unknown agent/thread.");
			if (agent.activeTurnId) {
				await deps.client.interruptTurn(agent.threadId, agent.activeTurnId);
			}
			deps.registry.markAwaitingInput(agent.threadId, "Interrupted by Director of Engineering.");
			return {
				content: [{ type: "text", text: `Interrupted ${agent.name} (${agent.id}).` }],
				details: { agent: deps.registry.getAgent(agent.id) },
			};
		},
	});
}
