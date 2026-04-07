import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import {
	extractThreadFileChanges,
	extractThreadMessages,
	extractThreadQueryEntries,
	extractTurnMessages,
	truncateForDisplay,
} from "../codex/client.ts";
import {
	formatUsageBreakdown,
	formatUsageCompact,
} from "../context-usage.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { formatContextStatusLines } from "./context-status.ts";
import { resolveSeatTarget } from "./resume-target.ts";
import { AgentLookupFields } from "./shared-schemas.ts";

const ActionSchema = StringEnum(["index", "files", "query", "transcript", "raw"] as const);
const MESSAGE_BLOCK_MAX_CHARS = 4_000;
const QUERY_MATCH_LIMIT = 8;
const ACTIVE_INSPECT_COOLDOWN_MS = 15_000;

function formatMessageBlock(
	text: string | null | undefined,
	maxChars = MESSAGE_BLOCK_MAX_CHARS,
): string {
	if (!text) { return "(none)"; }
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized) { return "(none)"; }
	if (normalized.length <= maxChars) { return normalized; }
	return `${normalized.slice(0, maxChars - 1)}…`;
}

function renderTranscript(thread: any): string {
	const messages = extractThreadMessages(thread);
	if (messages.length === 0) { return "(no user/agent messages found)"; }
	return messages
		.map((message, index) => {
			const label = message.role === "user" ? `User ${index + 1}` : `Agent ${index + 1}`;
			return `## ${label}\n${formatMessageBlock(message.text)}`;
		})
		.join("\n\n");
}

function formatFileStatLine(
	file: { path: string; addedLines: number | null; removedLines: number | null; changes: number },
): string {
	const stats = file.addedLines !== null || file.removedLines !== null
		? `+${file.addedLines ?? "?"}/-${file.removedLines ?? "?"}`
		: "stats=unavailable";
	return `- ${file.path} | ${stats} | changes=${file.changes}`;
}

function formatIndexFileSummary(
	files: Array<
		{ path: string; addedLines: number | null; removedLines: number | null; changes: number }
	>,
): string[] {
	if (files.length === 0) { return ["(no fileChange items found)"]; }
	const lines = files.slice(0, 8).map(formatFileStatLine);
	if (files.length > 8) { lines.push(`... +${files.length - 8} more`); }
	return lines;
}

function makeQueryExcerpt(text: string, query: string, maxChars = 260): string {
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const index = haystack.indexOf(needle);
	if (index < 0) { return formatMessageBlock(text, maxChars); }
	const start = Math.max(0, index - Math.floor((maxChars - needle.length) / 2));
	const end = Math.min(text.length, start + maxChars);
	const excerpt = text.slice(start, end).trim();
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${excerpt}${suffix}`;
}

interface InspectToolDeps {
	registry: DoeRegistry;
	client: CodexAppServerClient;
}

interface InspectExecutionContext {
	agent: any;
	thread: any;
	files: ReturnType<typeof extractThreadFileChanges>;
	queryEntries: ReturnType<typeof extractThreadQueryEntries>;
	firstUserMessage: string | null | undefined;
	lastAgentMessage: string | null | undefined;
	baseLines: string[];
}

const INSPECT_TOOL_META = {
	name: "codex_inspect",
	label: "Codex Inspect",
	description:
		"Inspect a named DOE IC assignment. Default action=index returns an overview; explicit actions provide files, query, transcript, or raw debug data.",
	promptSnippet:
		"Inspect a specific DOE IC assignment. Default action=index gives an overview; use files, query, transcript, or raw only for explicit follow-up lookups.",
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
		...AgentLookupFields,
		action: Type.Optional(ActionSchema),
		query: Type.Optional(Type.String()),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		force: Type.Optional(Type.Boolean()),
	}),
} as const;

function ensureInspectCooldown(
	agent: any,
	params: any,
	recentActiveInspects: Map<string, number>,
) {
	if ((agent.state !== "working" && agent.state !== "awaiting_input") || params.force) {
		return;
	}
	const lastInspectAt = recentActiveInspects.get(agent.id) ?? 0;
	if (Date.now() - lastInspectAt < ACTIVE_INSPECT_COOLDOWN_MS) {
		throw new Error(
			"Do not poll active workers with codex_inspect. Wait for the worker to finish, or retry later with force=true if the user explicitly asked for a live check.",
		);
	}
	recentActiveInspects.set(agent.id, Date.now());
}

function buildInspectBaseLines(agent: any, thread: any): string[] {
	return [
		`ic: ${agent.seatName ?? agent.name}`,
		`state: ${agent.state}`,
		`model: ${agent.model}`,
		`context: ${formatUsageCompact(agent.usage)}`,
		...formatContextStatusLines(agent.compaction),
		`mode: ${agent.allowWrite ? "write" : "read-only"}`,
		`cwd: ${agent.cwd}`,
		`agentId: ${agent.id}`,
		`threadId: ${agent.threadId}`,
		`turns: ${(thread.turns ?? []).length}`,
		`messages: ${extractThreadMessages(thread).length}`,
	];
}

function buildInspectResponse(lines: string[], details: Record<string, unknown>) {
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details,
	};
}

function buildInspectIndexResult(context: InspectExecutionContext) {
	const lines = [
		...context.baseLines,
		...formatUsageBreakdown(context.agent.usage, context.agent.compaction),
		`latest: ${
			truncateForDisplay(context.agent.latestFinalOutput ?? context.agent.latestSnippet, 300)
		}`,
		"",
		"first_user:",
		formatMessageBlock(context.firstUserMessage, 800),
		"",
		"latest_agent:",
		formatMessageBlock(context.lastAgentMessage, 800),
		"",
		"modified_files:",
		...formatIndexFileSummary(context.files),
		"",
		"follow_up_actions:",
		"- action=\"files\" for touched files and LOC stats",
		"- action=\"query\" with query=\"...\" for targeted history lookup",
		"- action=\"transcript\" for the full transcript",
		"- action=\"raw\" for raw thread metadata in details",
	];
	return buildInspectResponse(lines, {
		agent: context.agent,
		thread: context.thread,
		files: context.files,
	});
}

function buildInspectFilesResult(context: InspectExecutionContext) {
	const lines = [...context.baseLines, "", "files:"];
	if (context.files.length === 0) {
		lines.push("(no fileChange items found)");
		return buildInspectResponse(lines, {
			agent: context.agent,
			thread: context.thread,
			files: context.files,
		});
	}
	for (const file of context.files) {
		lines.push(formatFileStatLine(file));
	}
	return buildInspectResponse(lines, {
		agent: context.agent,
		thread: context.thread,
		files: context.files,
	});
}

function buildInspectQueryResult(context: InspectExecutionContext, params: any) {
	const query = params.query?.trim();
	if (!query) {
		throw new Error("codex_inspect action=\"query\" requires a non-empty query string.");
	}
	const limit = params.limit ?? QUERY_MATCH_LIMIT;
	const matches = context.queryEntries
		.filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase()))
		.slice(0, limit);
	const lines = [...context.baseLines, `query: ${query}`, `matches: ${matches.length}`];
	if (matches.length === 0) {
		lines.push("", "(no matches)");
		return buildInspectResponse(lines, {
			agent: context.agent,
			thread: context.thread,
			matches,
			query,
		});
	}
	for (const [index, match] of matches.entries()) {
		lines.push(
			"",
			`## match ${index + 1}`,
			`turn: ${match.turnId}`,
			`type: ${match.itemType}`,
			makeQueryExcerpt(match.text, query),
		);
	}
	return buildInspectResponse(lines, {
		agent: context.agent,
		thread: context.thread,
		matches,
		query,
	});
}

function buildInspectTranscriptResult(context: InspectExecutionContext) {
	const lines = [...context.baseLines, "", "transcript:", renderTranscript(context.thread)];
	return buildInspectResponse(lines, { agent: context.agent, thread: context.thread });
}

function buildInspectRawResult(context: InspectExecutionContext) {
	const lines = [
		...context.baseLines,
		`items: ${context.queryEntries.length}`,
		"",
		"[raw thread metadata kept in tool details only]",
	];
	return buildInspectResponse(lines, {
		agent: context.agent,
		thread: context.thread,
		files: context.files,
		queryEntries: context.queryEntries,
	});
}

async function createInspectExecutionContext(
	deps: InspectToolDeps,
	params: any,
	recentActiveInspects: Map<string, number>,
): Promise<InspectExecutionContext> {
	const agent = resolveSeatTarget(deps.registry, params, {
		includeFinished: true,
		missingSeatMessage: (ic) => `${ic} has no recorded assignment to inspect.`,
	});
	if (!agent?.threadId) {
		throw new Error("Unknown IC/agent/thread.");
	}
	ensureInspectCooldown(agent, params, recentActiveInspects);
	const threadResponse = await deps.client.readThread(agent.threadId, true);
	const thread = threadResponse.thread;
	const { firstUserMessage, lastAgentMessage } = extractTurnMessages(thread);
	const files = extractThreadFileChanges(thread);
	const queryEntries = extractThreadQueryEntries(thread);
	return {
		agent,
		thread,
		files,
		queryEntries,
		firstUserMessage,
		lastAgentMessage,
		baseLines: buildInspectBaseLines(agent, thread),
	};
}

function createInspectExecute(
	deps: InspectToolDeps,
	recentActiveInspects: Map<string, number>,
) {
	return async (_toolCallId: string, params: any) => {
		const context = await createInspectExecutionContext(deps, params, recentActiveInspects);
		const action = params.action ?? "index";
		if (action === "index") {
			return buildInspectIndexResult(context);
		}
		if (action === "files") {
			return buildInspectFilesResult(context);
		}
		if (action === "query") {
			return buildInspectQueryResult(context, params);
		}
		if (action === "transcript") {
			return buildInspectTranscriptResult(context);
		}
		return buildInspectRawResult(context);
	};
}

function createInspectTool(
	deps: InspectToolDeps,
	recentActiveInspects: Map<string, number>,
) {
	return {
		...INSPECT_TOOL_META,
		renderCall(args: any, theme: any) {
			const target = args.ic ?? args.agentId ?? args.threadId ?? "thread";
			const action = args.action ?? "index";
			return new Text(theme.fg("accent", `codex_inspect ${target} action=${action}`), 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			return new Text(
				theme.fg("accent", "codex_inspect") + "\n" + (result.content?.[0]?.text ?? ""),
				0,
				0,
			);
		},
		execute: createInspectExecute(deps, recentActiveInspects),
	};
}

export function registerInspectTool(pi: ExtensionAPI, deps: InspectToolDeps) {
	const recentActiveInspects = new Map<string, number>();
	pi.registerTool(createInspectTool(deps, recentActiveInspects));
}
