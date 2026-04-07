import type {
	CurrentContextUsage,
	ThreadTokenUsage,
	TokenUsageBreakdown,
} from "../context-usage.ts";
import { isRecord } from "../utils/guards.ts";
import type { AgentActivity, CodexClientEvent } from "./client.ts";

export interface AppServerNotificationContext {
	emit: (event: CodexClientEvent) => void;
	threadWriteAccess: Map<string, boolean>;
}

function threadIdFrom(params: any): string {
	return String(params.threadId ?? "");
}

function turnIdFrom(params: any): string | null {
	return typeof params.turnId === "string" ? params.turnId : null;
}

function emitThreadStarted(params: any, ctx: AppServerNotificationContext): boolean {
	const thread = params.thread;
	if (thread?.id && !ctx.threadWriteAccess.has(String(thread.id))) {
		ctx.threadWriteAccess.set(
			String(thread.id),
			thread.sandbox?.type === "workspaceWrite" || thread.sandbox?.type === "dangerFullAccess",
		);
	}
	ctx.emit({
		type: "thread-started",
		thread,
	} satisfies CodexClientEvent);
	return true;
}

function emitThreadStatus(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "thread-status",
		threadId: threadIdFrom(params),
		status: params.status,
	} satisfies CodexClientEvent);
	return true;
}

function emitThreadTokenUsage(params: any, ctx: AppServerNotificationContext): boolean {
	const usage = normalizeCurrentContextUsage(params.usage ?? params.tokenUsage);
	if (!usage) {
		const tokenUsage = normalizeThreadTokenUsage(params.tokenUsage);
		if (!tokenUsage) {
			return true;
		}
		const fallback = normalizeCurrentContextUsage({
			last_token_usage: { total_tokens: tokenUsage.last.totalTokens },
			total_token_usage: { total_tokens: tokenUsage.total.totalTokens },
			model_context_window: tokenUsage.modelContextWindow,
		});
		if (!fallback) {
			return true;
		}
		ctx.emit({
			type: "thread-token-usage",
			threadId: threadIdFrom(params),
			turnId: turnIdFrom(params),
			usage: fallback,
		} satisfies CodexClientEvent);
		return true;
	}
	ctx.emit({
		type: "thread-token-usage",
		threadId: threadIdFrom(params),
		turnId: turnIdFrom(params),
		usage,
	} satisfies CodexClientEvent);
	return true;
}

function emitThreadCompacted(
	params: any,
	ctx: AppServerNotificationContext,
	source: "thread/compacted" | "contextCompaction",
): boolean {
	ctx.emit({
		type: "thread-compaction-completed",
		threadId: threadIdFrom(params),
		turnId: turnIdFrom(params),
		itemId: null,
		source,
	} satisfies CodexClientEvent);
	return true;
}

function emitTurnStarted(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "turn-started",
		threadId: threadIdFrom(params),
		turnId: params.turn?.id,
	} satisfies CodexClientEvent);
	return true;
}

function emitCompactionStarted(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "thread-compaction-started",
		threadId: threadIdFrom(params),
		turnId: turnIdFrom(params),
		itemId: typeof params.item?.id === "string" ? params.item.id : null,
	} satisfies CodexClientEvent);
	return true;
}

function emitAgentActivity(
	params: any,
	ctx: AppServerNotificationContext,
	activity: AgentActivity,
): boolean {
	ctx.emit({
		type: "agent-activity",
		threadId: threadIdFrom(params),
		activity,
	} satisfies CodexClientEvent);
	return true;
}

function emitTurnCompleted(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "turn-completed",
		threadId: threadIdFrom(params),
		turnId: params.turn?.id,
		status: params.turn?.status,
		error: params.turn?.error?.message ?? null,
	} satisfies CodexClientEvent);
	return true;
}

function emitAgentMessageDelta(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "agent-message-delta",
		threadId: threadIdFrom(params),
		turnId: String(params.turnId ?? ""),
		itemId: String(params.itemId ?? ""),
		delta: typeof params.delta === "string" ? params.delta : "",
	} satisfies CodexClientEvent);
	return true;
}

function emitAgentMessageComplete(params: any, ctx: AppServerNotificationContext): boolean {
	ctx.emit({
		type: "agent-message-complete",
		threadId: threadIdFrom(params),
		turnId: String(params.turnId ?? ""),
		itemId: String(params.item.id ?? ""),
		text: typeof params.item.text === "string" ? params.item.text : "",
	} satisfies CodexClientEvent);
	return true;
}

function emitError(params: any, ctx: AppServerNotificationContext): boolean {
	const error = params.error;
	ctx.emit({
		type: "error",
		threadId: typeof params.threadId === "string" ? params.threadId : undefined,
		message: error?.message ?? JSON.stringify(params),
	} satisfies CodexClientEvent);
	return true;
}

function handleThreadStartedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitThreadStarted(params, ctx);
}

function handleThreadStatusNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitThreadStatus(params, ctx);
}

function handleThreadTokenUsageNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitThreadTokenUsage(params, ctx);
}

function handleThreadCompactedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitThreadCompacted(params, ctx, "thread/compacted");
}

function handleTurnStartedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitTurnStarted(params, ctx);
}

function handleItemStartedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	if (params.item?.type === "contextCompaction") {
		return emitCompactionStarted(params, ctx);
	}
	const activity = activityFromItem(params.item, "started");
	if (activity) {
		return emitAgentActivity(params, ctx, activity);
	}
	return true;
}

function handleTurnCompletedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitTurnCompleted(params, ctx);
}

function handleAgentMessageDeltaNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	return emitAgentMessageDelta(params, ctx);
}

function handleItemCompletedNotification(
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	if (params.item?.type === "contextCompaction") {
		return emitThreadCompacted(params, ctx, "contextCompaction");
	}
	const activity = activityFromItem(params.item, "completed");
	if (activity) {
		emitAgentActivity(params, ctx, activity);
	}
	if (params.item?.type === "agentMessage") {
		return emitAgentMessageComplete(params, ctx);
	}
	return true;
}

function handleErrorNotification(params: any, ctx: AppServerNotificationContext): boolean {
	return emitError(params, ctx);
}

function activityFromItem(item: unknown, event: "started" | "completed"): AgentActivity | null {
	if (!isRecord(item)) {
		return null;
	}
	const type = item.type;
	if (type === "reasoning") {
		return "thinking";
	}
	if (type === "plan") {
		return event === "started" ? "planning" : "thinking";
	}
	if (
		type === "commandExecution"
		|| type === "dynamicToolCall"
		|| type === "mcpToolCall"
		|| type === "collabAgentToolCall"
		|| type === "webSearch"
		|| type === "imageView"
	) {
		return event === "started" ? "using tools" : "thinking";
	}
	if (type === "fileChange") {
		return event === "started" ? "editing files" : "thinking";
	}
	if (type === "agentMessage") {
		return event === "started" ? "writing response" : "thinking";
	}
	return null;
}

function normalizeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeBreakdown(value: unknown): TokenUsageBreakdown {
	const input: any = value && typeof value === "object" ? value : {};
	return {
		totalTokens: normalizeNumber(input.totalTokens),
		inputTokens: normalizeNumber(input.inputTokens),
		cachedInputTokens: normalizeNumber(input.cachedInputTokens),
		outputTokens: normalizeNumber(input.outputTokens),
		reasoningOutputTokens: normalizeNumber(input.reasoningOutputTokens),
	};
}

const NOTIFICATION_HANDLERS: Record<
	string,
	(params: any, ctx: AppServerNotificationContext) => boolean
> = {
	"thread/started": handleThreadStartedNotification,
	"thread/status/changed": handleThreadStatusNotification,
	"thread/tokenUsage/updated": handleThreadTokenUsageNotification,
	"thread/compacted": handleThreadCompactedNotification,
	"turn/started": handleTurnStartedNotification,
	"item/started": handleItemStartedNotification,
	"turn/completed": handleTurnCompletedNotification,
	"item/agentMessage/delta": handleAgentMessageDeltaNotification,
	"item/completed": handleItemCompletedNotification,
	error: handleErrorNotification,
};

export function normalizeThreadTokenUsage(value: unknown): ThreadTokenUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const input: any = value;
	const window =
		typeof input.modelContextWindow === "number" && Number.isFinite(input.modelContextWindow)
			? input.modelContextWindow
			: null;
	return {
		total: normalizeBreakdown(input.total),
		last: normalizeBreakdown(input.last),
		modelContextWindow: window,
	};
}

export function normalizeCurrentContextUsage(value: unknown): CurrentContextUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const input: any = value;
	const tokensUsedCandidates = [
		input.tokensUsed,
		input.tokens_used,
		input.last_token_usage?.total_tokens,
		input.lastTokenUsage?.totalTokens,
		input.total_token_usage?.total_tokens,
		input.totalTokenUsage?.totalTokens,
	];
	const tokenLimitCandidates = [
		input.tokenLimit,
		input.token_limit,
		input.model_context_window,
		input.modelContextWindow,
		input.context_window,
		input.contextWindow,
	];
	const rawTokensUsed = tokensUsedCandidates.find((entry) =>
		typeof entry === "number" && Number.isFinite(entry)
	);
	const rawTokenLimit = tokenLimitCandidates.find((entry) =>
		typeof entry === "number" && Number.isFinite(entry)
	);
	if (
		typeof rawTokensUsed !== "number" || typeof rawTokenLimit !== "number" || rawTokenLimit <= 0
	) {
		return null;
	}
	return {
		tokensUsed: Math.max(0, Math.min(rawTokensUsed, rawTokenLimit)),
		tokenLimit: rawTokenLimit,
	};
}

export function handleAppServerNotification(
	method: string,
	params: any,
	ctx: AppServerNotificationContext,
): boolean {
	const handler = NOTIFICATION_HANDLERS[method];
	if (!handler) {
		return false;
	}
	return handler(params, ctx);
}
