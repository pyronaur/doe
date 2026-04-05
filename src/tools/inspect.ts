import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { extractTurnMessages, truncateForDisplay } from "../codex/client.js";
import type { SysopRegistry } from "../state/registry.js";

const HistorySchema = StringEnum(["summary", "first_last", "full"] as const);
const ACTIVE_INSPECT_COOLDOWN_MS = 15_000;

export function registerInspectTool(
	pi: ExtensionAPI,
	deps: { registry: SysopRegistry; client: CodexAppServerClient },
) {
	const recentActiveInspects = new Map<string, number>();

	pi.registerTool({
		name: "codex_inspect",
		label: "Codex Inspect",
		description: "Inspect a Codex workstream, including the latest snippet and stored thread history.",
		promptSnippet: "Inspect a worker when you need its latest snippet, state, or first/last messages.",
		promptGuidelines: [
			"Use this for one-off lookups, explicit user requests, or thread-selection clarity.",
			"Do not use this tool as a polling loop for active async workers; wait for completion notifications instead.",
		],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
			history: Type.Optional(HistorySchema),
			force: Type.Optional(Type.Boolean()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_inspect ${(args as any).agentId ?? (args as any).threadId ?? "thread"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", "codex_inspect") + "\n" + (result.content?.[0]?.text ?? ""), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agent = params.agentId
				? deps.registry.findAgent(params.agentId)
				: params.threadId
					? deps.registry.findAgent(params.threadId)
					: undefined;
			if (!agent?.threadId) throw new Error("Unknown agent/thread.");

			const history = params.history ?? "first_last";
			if ((agent.state === "working" || agent.state === "awaiting_input") && !params.force) {
				const lastInspectAt = recentActiveInspects.get(agent.id) ?? 0;
				if (Date.now() - lastInspectAt < ACTIVE_INSPECT_COOLDOWN_MS) {
					throw new Error("Do not poll active workers with codex_inspect. Wait for the completion steer, or retry later with force=true if the user explicitly asked for a live check.");
				}
				recentActiveInspects.set(agent.id, Date.now());
			}
			if (history === "summary") {
				const text = [
					`id: ${agent.id}`,
					`thread: ${agent.threadId}`,
					`name: ${agent.name}`,
					`state: ${agent.state}`,
					`model: ${agent.model}`,
					`mode: ${agent.allowWrite ? "write" : "read-only"}`,
					`cwd: ${agent.cwd}`,
					`latest: ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 300)}`,
				].join("\n");
				return { content: [{ type: "text", text }], details: { agent } };
			}

			const threadResponse = await deps.client.readThread(agent.threadId, true);
			const thread = threadResponse.thread;
			const { firstUserMessage, lastAgentMessage } = extractTurnMessages(thread);
			const lines = [
				`id: ${agent.id}`,
				`thread: ${agent.threadId}`,
				`name: ${agent.name}`,
				`state: ${agent.state}`,
				`model: ${agent.model}`,
				`mode: ${agent.allowWrite ? "write" : "read-only"}`,
				`cwd: ${agent.cwd}`,
				`latest: ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 300)}`,
				`first_user: ${truncateForDisplay(firstUserMessage, 300)}`,
				`last_agent: ${truncateForDisplay(lastAgentMessage, 300)}`,
			];

			if (history === "full") {
				lines.push("", JSON.stringify(thread, null, 2));
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { agent, thread },
			};
		},
	});
}
