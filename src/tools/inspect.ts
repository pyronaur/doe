import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { extractThreadMessages, extractTurnMessages, truncateForDisplay } from "../codex/client.js";
import type { SysopRegistry } from "../state/registry.js";

const HistorySchema = StringEnum(["summary", "first_last", "transcript", "full", "raw"] as const);
const MESSAGE_BLOCK_MAX_CHARS = 4_000;
const ACTIVE_INSPECT_COOLDOWN_MS = 15_000;

function formatMessageBlock(text: string | null | undefined, maxChars = MESSAGE_BLOCK_MAX_CHARS): string {
	if (!text) return "(none)";
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return "(none)";
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars - 1)}…`;
}

function renderTranscript(thread: any): string {
	const messages = extractThreadMessages(thread);
	if (messages.length === 0) return "(no user/agent messages found)";
	return messages
		.map((message, index) => {
			const label = message.role === "user" ? `User ${index + 1}` : `Agent ${index + 1}`;
			return `## ${label}\n${formatMessageBlock(message.text)}`;
		})
		.join("\n\n");
}

export function registerInspectTool(
	pi: ExtensionAPI,
	deps: { registry: SysopRegistry; client: CodexAppServerClient },
) {
	const recentActiveInspects = new Map<string, number>();

	pi.registerTool({
		name: "codex_inspect",
		label: "Codex Inspect",
		description: "Inspect a Codex workstream, including readable prompts, outputs, and thread history.",
		promptSnippet: "Inspect a worker when you need its exact prompt, latest output, or a readable transcript.",
		promptGuidelines: [
			"Use this for one-off lookups, explicit user requests, or thread-selection clarity.",
			"Prefer history=first_last or history=transcript for readable prompts and outputs.",
			"Use history=raw only for debugging metadata; raw thread objects stay in tool details, not the conversational output.",
			"Do not use this tool as a polling loop for active workers.",
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
					throw new Error("Do not poll active workers with codex_inspect. Wait for the worker to finish, or retry later with force=true if the user explicitly asked for a live check.");
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
			const transcript = renderTranscript(thread);
			const lines = [
				`id: ${agent.id}`,
				`thread: ${agent.threadId}`,
				`name: ${agent.name}`,
				`state: ${agent.state}`,
				`model: ${agent.model}`,
				`mode: ${agent.allowWrite ? "write" : "read-only"}`,
				`cwd: ${agent.cwd}`,
				`latest: ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 300)}`,
				`turns: ${(thread.turns ?? []).length}`,
				`messages: ${extractThreadMessages(thread).length}`,
			];

			if (history === "first_last") {
				lines.push(
					"",
					"first_user:",
					formatMessageBlock(firstUserMessage),
					"",
					"last_agent:",
					formatMessageBlock(lastAgentMessage),
				);
			} else {
				lines.push("", "transcript:", transcript);
				if (history === "raw") {
					lines.push("", "[raw thread metadata kept in tool details only]");
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { agent, thread },
			};
		},
	});
}
