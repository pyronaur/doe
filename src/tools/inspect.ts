import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import {
	extractThreadFileChanges,
	extractThreadMessages,
	extractThreadQueryEntries,
	extractTurnMessages,
	truncateForDisplay,
} from "../codex/client.js";
import { formatCompactionSignal, formatUsageBreakdown, formatUsageCompact } from "../context-usage.js";
import type { DoeRegistry } from "../state/registry.js";

const ActionSchema = StringEnum(["index", "files", "query", "transcript", "raw"] as const);
const MESSAGE_BLOCK_MAX_CHARS = 4_000;
const QUERY_MATCH_LIMIT = 8;
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

function formatFileStatLine(file: { path: string; addedLines: number | null; removedLines: number | null; changes: number }): string {
	const stats =
		file.addedLines !== null || file.removedLines !== null
			? `+${file.addedLines ?? "?"}/-${file.removedLines ?? "?"}`
			: "stats=unavailable";
	return `- ${file.path} | ${stats} | changes=${file.changes}`;
}

function formatIndexFileSummary(files: Array<{ path: string; addedLines: number | null; removedLines: number | null; changes: number }>): string[] {
	if (files.length === 0) return ["(no fileChange items found)"];
	const lines = files.slice(0, 8).map(formatFileStatLine);
	if (files.length > 8) lines.push(`... +${files.length - 8} more`);
	return lines;
}

function makeQueryExcerpt(text: string, query: string, maxChars = 260): string {
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const index = haystack.indexOf(needle);
	if (index < 0) return formatMessageBlock(text, maxChars);
	const start = Math.max(0, index - Math.floor((maxChars - needle.length) / 2));
	const end = Math.min(text.length, start + maxChars);
	const excerpt = text.slice(start, end).trim();
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${excerpt}${suffix}`;
}

function resolveInspectTarget(registry: DoeRegistry, params: any) {
	if (params.ic) {
		const active = registry.findActiveSeatAgent(params.ic);
		if (active) return active;
		const finished = registry.findLastFinishedSeatAgent(params.ic);
		if (finished) return finished;
		if (registry.findSeat(params.ic)) {
			throw new Error(`${params.ic} has no recorded assignment to inspect.`);
		}
	}
	if (params.agentId) return registry.findAgent(params.agentId);
	if (params.threadId) return registry.findAgent(params.threadId);
	return undefined;
}

export function registerInspectTool(
	pi: ExtensionAPI,
	deps: { registry: DoeRegistry; client: CodexAppServerClient },
) {
	const recentActiveInspects = new Map<string, number>();

	pi.registerTool({
		name: "codex_inspect",
		label: "Codex Inspect",
		description: "Inspect a named DOE IC assignment. Default action=index returns an overview; explicit actions provide files, query, transcript, or raw debug data.",
		promptSnippet: "Inspect a specific DOE IC assignment. Default action=index gives an overview; use files, query, transcript, or raw only for explicit follow-up lookups.",
		promptGuidelines: [
			"Prefer ic for named-seat lookup. agentId and threadId remain available for legacy/debug use.",
			"Default action is index. Use it for a workstream overview, not to read a normal completed-worker result.",
			"Do not use inspect as a polling loop. Wait for the worker to finish, or retry later with force=true only when the user explicitly asked for a live check.",
			"Use action=files for changed-file and LOC lookup.",
			"Use action=query for targeted thread-history lookup with a query string.",
			"Use action=transcript or action=raw only when you explicitly need transcript/debug data.",
			"Returns threadId — use this when codex_resume needs a threadId instead of agentId.",
		],
		parameters: Type.Object({
			ic: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
			action: Type.Optional(ActionSchema),
			query: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
			force: Type.Optional(Type.Boolean()),
		}),
		renderCall(args, theme) {
			const target = (args as any).ic ?? (args as any).agentId ?? (args as any).threadId ?? "thread";
			const action = (args as any).action ?? "index";
			return new Text(theme.fg("accent", `codex_inspect ${target} action=${action}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", "codex_inspect") + "\n" + (result.content?.[0]?.text ?? ""), 0, 0);
		},
		async execute(_toolCallId, params) {
			const agent = resolveInspectTarget(deps.registry, params);
			if (!agent?.threadId) throw new Error("Unknown IC/agent/thread.");

			if ((agent.state === "working" || agent.state === "awaiting_input") && !params.force) {
				const lastInspectAt = recentActiveInspects.get(agent.id) ?? 0;
				if (Date.now() - lastInspectAt < ACTIVE_INSPECT_COOLDOWN_MS) {
					throw new Error("Do not poll active workers with codex_inspect. Wait for the worker to finish, or retry later with force=true if the user explicitly asked for a live check.");
				}
				recentActiveInspects.set(agent.id, Date.now());
			}

			const action = params.action ?? "index";
			const threadResponse = await deps.client.readThread(agent.threadId, true);
			const thread = threadResponse.thread;
			const { firstUserMessage, lastAgentMessage } = extractTurnMessages(thread);
			const files = extractThreadFileChanges(thread);
			const queryEntries = extractThreadQueryEntries(thread);
			const baseLines = [
				`ic: ${agent.seatName ?? agent.name}`,
				`state: ${agent.state}`,
				`model: ${agent.model}`,
				`context: ${formatUsageCompact(agent.usage)}`,
				...(formatCompactionSignal(agent.compaction) ? [`context_status: ${formatCompactionSignal(agent.compaction)}`] : []),
				`mode: ${agent.allowWrite ? "write" : "read-only"}`,
				`cwd: ${agent.cwd}`,
				`agentId: ${agent.id}`,
				`threadId: ${agent.threadId}`,
				`turns: ${(thread.turns ?? []).length}`,
				`messages: ${extractThreadMessages(thread).length}`,
			];

			if (action === "index") {
				const lines = [
					...baseLines,
					...formatUsageBreakdown(agent.usage, agent.compaction),
					`latest: ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 300)}`,
					"",
					"first_user:",
					formatMessageBlock(firstUserMessage, 800),
					"",
					"latest_agent:",
					formatMessageBlock(lastAgentMessage, 800),
					"",
					"modified_files:",
					...formatIndexFileSummary(files),
					"",
					"follow_up_actions:",
					'- action="files" for touched files and LOC stats',
					'- action="query" with query="..." for targeted history lookup',
					'- action="transcript" for the full transcript',
					'- action="raw" for raw thread metadata in details',
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agent, thread, files },
				};
			}

			if (action === "files") {
				const lines = [...baseLines, "", "files:"];
				if (files.length === 0) {
					lines.push("(no fileChange items found)");
				} else {
					for (const file of files) {
						lines.push(formatFileStatLine(file));
					}
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agent, thread, files },
				};
			}

			if (action === "query") {
				const query = params.query?.trim();
				if (!query) throw new Error('codex_inspect action="query" requires a non-empty query string.');
				const limit = params.limit ?? QUERY_MATCH_LIMIT;
				const matches = queryEntries
					.filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase()))
					.slice(0, limit);
				const lines = [...baseLines, `query: ${query}`, `matches: ${matches.length}`];
				if (matches.length === 0) {
					lines.push("", "(no matches)");
				} else {
					for (const [index, match] of matches.entries()) {
						lines.push(
							"",
							`## match ${index + 1}`,
							`turn: ${match.turnId}`,
							`type: ${match.itemType}`,
							makeQueryExcerpt(match.text, query),
						);
					}
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agent, thread, matches, query },
				};
			}

			if (action === "transcript") {
				const lines = [...baseLines, "", "transcript:", renderTranscript(thread)];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agent, thread },
				};
			}

			const rawLines = [
				...baseLines,
				`items: ${queryEntries.length}`,
				"",
				"[raw thread metadata kept in tool details only]",
			];
			return {
				content: [{ type: "text", text: rawLines.join("\n") }],
				details: { agent, thread, files, queryEntries },
			};
		},
	});
}
