import type { CurrentContextUsage, ThreadTokenUsage } from "../context-usage.js";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";

export interface ThreadSummary {
	id: string;
	name?: string | null;
	preview?: string;
	cwd?: string;
	status?: { type?: string; activeFlags?: string[] } | null;
	turns?: Array<{
		id: string;
		status: string;
		createdAt?: string | number | null;
		error?: { message?: string | null } | null;
		items?: Array<any>;
	}>;
}

export interface ThreadMessageEntry {
	turnId: string;
	role: "user" | "agent";
	text: string;
}

export interface ThreadTranscriptEntry {
	turnId: string;
	itemId: string | null;
	role: "user" | "agent";
	text: string;
	streaming: boolean;
	createdAt: number;
	completedAt?: number | null;
}

export interface ThreadFileChangeSummary {
	path: string;
	addedLines: number | null;
	removedLines: number | null;
	changes: number;
	turnIds: string[];
}

export interface ThreadQueryEntry {
	turnId: string;
	itemId: string | null;
	itemType: string;
	text: string;
}

export type AgentActivity =
	| "starting"
	| "thinking"
	| "using tools"
	| "writing response"
	| "planning"
	| "editing files"
	| "awaiting approval"
	| "awaiting input"
	| "completed"
	| "error";

export interface ThreadStartOptions {
	model: string;
	cwd: string;
	approvalPolicy?: ApprovalPolicy;
	networkAccess?: boolean;
	sandbox?: SandboxMode;
	serviceName?: string;
	baseInstructions?: string;
	developerInstructions?: string;
	ephemeral?: boolean;
	allowWrite?: boolean;
}

export interface TurnStartOptions {
	threadId: string;
	prompt: string;
	cwd: string;
	model: string;
	effort?: ReasoningEffort;
	approvalPolicy?: ApprovalPolicy;
	networkAccess?: boolean;
	sandbox?: SandboxMode;
	allowWrite?: boolean;
}

export interface TurnSteerOptions {
	threadId: string;
	expectedTurnId: string;
	prompt: string;
}

export type CodexClientEvent =
	| { type: "thread-started"; thread: ThreadSummary }
	| { type: "thread-status"; threadId: string; status: { type?: string; activeFlags?: string[] } }
	| { type: "thread-token-usage"; threadId: string; turnId: string | null; usage: CurrentContextUsage }
	| { type: "thread-compaction-started"; threadId: string; turnId: string | null; itemId: string | null }
	| { type: "thread-compaction-completed"; threadId: string; turnId: string | null; itemId: string | null; source: "contextCompaction" | "thread/compacted" }
	| { type: "turn-started"; threadId: string; turnId: string }
	| { type: "turn-completed"; threadId: string; turnId: string; status: string; error?: string | null }
	| { type: "agent-message-delta"; threadId: string; turnId: string; itemId: string; delta: string }
	| { type: "agent-message-complete"; threadId: string; turnId: string; itemId: string; text: string }
	| { type: "agent-activity"; threadId: string; activity: AgentActivity }
	| { type: "error"; threadId?: string; message: string };

export function buildReadOnlySandbox(networkAccess = false) {
	return {
		type: "readOnly",
		access: { type: "fullAccess" },
		networkAccess,
	} as const;
}

export function buildDangerFullAccessSandbox() {
	return {
		type: "dangerFullAccess",
	} as const;
}

function isRecord(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findNestedValue<T>(
	value: unknown,
	predicate: (current: unknown, key: string | null) => current is T,
	depth = 0,
	seen = new Set<unknown>(),
): T | null {
	if (depth > 6 || value === null || value === undefined) return null;
	if (typeof value === "object") {
		if (seen.has(value)) return null;
		seen.add(value);
	}
	if (predicate(value, null)) return value;
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = findNestedValue(entry, predicate, depth + 1, seen);
			if (found !== null) return found;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	for (const [key, entry] of Object.entries(value)) {
		if (predicate(entry, key)) return entry;
		const found = findNestedValue(entry, predicate, depth + 1, seen);
		if (found !== null) return found;
	}
	return null;
}

function findNestedString(value: unknown, keys: string[]): string | null {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	return findNestedValue(
		value,
		(current, key): current is string =>
			typeof current === "string" && current.trim().length > 0 && key !== null && keySet.has(key.toLowerCase()),
	);
}

function findNestedNumber(value: unknown, keys: string[]): number | null {
	const keySet = new Set(keys.map((key) => key.toLowerCase()));
	return findNestedValue(
		value,
		(current, key): current is number => typeof current === "number" && Number.isFinite(current) && key !== null && keySet.has(key.toLowerCase()),
	);
}

export function getThreadItemText(item: any): string {
	if (!item || typeof item !== "object") return "";
	if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
	if (Array.isArray(item.content)) {
		const text = item.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function getThreadItemPath(item: any): string | null {
	const direct = [item?.path, item?.filePath, item?.targetPath, item?.destinationPath, item?.relativePath].find(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
	if (typeof direct === "string") return direct.trim();
	const oldPath = typeof item?.oldPath === "string" && item.oldPath.trim() ? item.oldPath.trim() : null;
	const newPath = typeof item?.newPath === "string" && item.newPath.trim() ? item.newPath.trim() : null;
	if (oldPath && newPath) return oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`;
	return findNestedString(item, ["path", "filePath", "targetPath", "destinationPath", "relativePath"]);
}

function getThreadItemDiffStats(item: any): { addedLines: number | null; removedLines: number | null } {
	const addedLines =
		findNestedNumber(item, ["addedLines", "linesAdded", "added", "insertions", "lineAdds", "lineAdditions"]) ?? null;
	const removedLines =
		findNestedNumber(item, ["removedLines", "linesRemoved", "removed", "deletions", "lineDeletes", "lineDeletions"]) ?? null;
	return { addedLines, removedLines };
}

function summarizeThreadItem(item: any): string {
	const text = getThreadItemText(item);
	if (text) return text;
	if (item?.type === "commandExecution") {
		const command = findNestedString(item, ["command", "cmd"]);
		const stdout = findNestedString(item, ["stdout"]);
		const stderr = findNestedString(item, ["stderr"]);
		return [command ? `$ ${command}` : null, stdout, stderr].filter(Boolean).join("\n").trim();
	}
	if (item?.type === "fileChange") {
		const path = getThreadItemPath(item) ?? "(unknown path)";
		const { addedLines, removedLines } = getThreadItemDiffStats(item);
		const stats = addedLines !== null || removedLines !== null ? ` (+${addedLines ?? "?"}/-${removedLines ?? "?"})` : "";
		return `fileChange ${path}${stats}`;
	}
	return "";
}

function parseTimestamp(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function extractThreadTranscript(thread: ThreadSummary | null | undefined): ThreadTranscriptEntry[] {
	const messages: ThreadTranscriptEntry[] = [];
	let fallbackTime = 1;

	for (const turn of thread?.turns ?? []) {
		for (const item of turn.items ?? []) {
			if (item?.type !== "userMessage" && item?.type !== "agentMessage") continue;
			const text = getThreadItemText(item);
			if (!text) continue;
			const createdAt = parseTimestamp(item?.createdAt ?? turn?.createdAt, fallbackTime++);
			const completedAt = item?.type === "agentMessage" ? parseTimestamp(item?.completedAt, createdAt) : createdAt;
			messages.push({
				turnId: turn.id,
				itemId: typeof item?.id === "string" ? item.id : null,
				role: item.type === "userMessage" ? "user" : "agent",
				text,
				streaming: false,
				createdAt,
				completedAt,
			});
		}
	}

	return messages;
}

export function extractThreadMessages(thread: ThreadSummary | null | undefined): ThreadMessageEntry[] {
	return extractThreadTranscript(thread).map((message) => ({
		turnId: message.turnId,
		role: message.role,
		text: message.text,
	}));
}

export function extractTurnMessages(thread: ThreadSummary | null | undefined): {
	firstUserMessage: string | null;
	lastAgentMessage: string | null;
} {
	let firstUserMessage: string | null = null;
	let lastAgentMessage: string | null = null;

	for (const message of extractThreadMessages(thread)) {
		if (message.role === "user" && firstUserMessage === null) {
			firstUserMessage = message.text;
		}
		if (message.role === "agent") {
			lastAgentMessage = message.text;
		}
	}

	return { firstUserMessage, lastAgentMessage };
}

export function extractLastCompletedAgentMessage(thread: ThreadSummary | null | undefined): string | null {
	const messages = extractThreadTranscript(thread);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === "agent" && message.text.trim().length > 0) return message.text;
	}
	return null;
}

export function extractThreadFileChanges(thread: ThreadSummary | null | undefined): ThreadFileChangeSummary[] {
	const summaries = new Map<string, ThreadFileChangeSummary>();
	for (const turn of thread?.turns ?? []) {
		for (const item of turn.items ?? []) {
			if (item?.type !== "fileChange") continue;
			const path = getThreadItemPath(item) ?? "(unknown path)";
			const { addedLines, removedLines } = getThreadItemDiffStats(item);
			const existing = summaries.get(path);
			if (existing) {
				existing.changes += 1;
				if (!existing.turnIds.includes(turn.id)) existing.turnIds.push(turn.id);
				if (addedLines !== null) existing.addedLines = (existing.addedLines ?? 0) + addedLines;
				if (removedLines !== null) existing.removedLines = (existing.removedLines ?? 0) + removedLines;
			} else {
				summaries.set(path, {
					path,
					addedLines,
					removedLines,
					changes: 1,
					turnIds: [turn.id],
				});
			}
		}
	}
	return [...summaries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function extractThreadQueryEntries(thread: ThreadSummary | null | undefined): ThreadQueryEntry[] {
	const entries: ThreadQueryEntry[] = [];
	for (const turn of thread?.turns ?? []) {
		for (const item of turn.items ?? []) {
			const text = summarizeThreadItem(item).trim();
			if (!text) continue;
			entries.push({
				turnId: turn.id,
				itemId: typeof item?.id === "string" ? item.id : null,
				itemType: typeof item?.type === "string" ? item.type : "unknown",
				text,
			});
		}
	}
	return entries;
}

export function truncateForDisplay(text: string | null | undefined, max = 220): string {
	if (!text) return "";
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}
