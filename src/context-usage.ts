export interface TokenUsageBreakdown {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
	total: TokenUsageBreakdown;
	last: TokenUsageBreakdown;
	modelContextWindow: number | null;
}

export interface CurrentContextUsage {
	tokensUsed: number;
	tokenLimit: number;
}

export interface AgentCompactionState {
	inProgress: boolean;
	count: number;
	lastStartedAt: number | null;
	lastCompletedAt: number | null;
	lastTurnId: string | null;
	lastItemId: string | null;
	lastSignal: "contextCompaction" | "thread/compacted" | null;
}

export interface AgentUsageSnapshot extends ThreadTokenUsage {
	turnId: string | null;
	tokensUsed: number | null;
	tokenLimit: number | null;
	remainingTokens: number | null;
	usedPercent: number | null;
	availablePercent: number | null;
	updatedAt: number;
}

function formatCount(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) { return "?"; }
	return value.toLocaleString();
}

function formatCompactCount(value: number | null | undefined): string {
	if (typeof value !== "number" || !Number.isFinite(value)) { return "?"; }
	if (value >= 1_000_000) { return `${Math.round(value / 100_000) / 10}M`; }
	if (value >= 1_000) { return `${Math.round(value / 100) / 10}k`; }
	return String(value);
}

function usageFreshness(
	snapshot: AgentUsageSnapshot | null | undefined,
	compaction: AgentCompactionState | null | undefined,
): "normal" | "post_compaction" | "stale_after_compaction" {
	if (!snapshot || !compaction?.lastCompletedAt) { return "normal"; }
	return snapshot.updatedAt > compaction.lastCompletedAt
		? "post_compaction"
		: "stale_after_compaction";
}

function normalizeEffectiveUsage(
	input: ThreadTokenUsage | CurrentContextUsage,
): CurrentContextUsage | null {
	if ("tokensUsed" in input && "tokenLimit" in input) {
		if (
			!Number.isFinite(input.tokensUsed) || !Number.isFinite(input.tokenLimit)
			|| input.tokenLimit <= 0
		) { return null; }
		return {
			tokensUsed: Math.max(0, Math.min(input.tokensUsed, input.tokenLimit)),
			tokenLimit: input.tokenLimit,
		};
	}
	const tokenLimit = input.modelContextWindow;
	if (!Number.isFinite(tokenLimit) || tokenLimit === null || tokenLimit <= 0) { return null; }
	const lastTotal = input.last?.totalTokens;
	const totalTotal = input.total?.totalTokens;
	const fallbackTotal = (input.last?.inputTokens ?? 0) + (input.last?.outputTokens ?? 0)
		+ (input.last?.reasoningOutputTokens ?? 0);
	const rawTokensUsed = typeof lastTotal === "number" && Number.isFinite(lastTotal) && lastTotal > 0
		? lastTotal
		: typeof totalTotal === "number" && Number.isFinite(totalTotal)
		? totalTotal
		: fallbackTotal;
	return {
		tokensUsed: Math.max(0, Math.min(rawTokensUsed, tokenLimit)),
		tokenLimit,
	};
}

export function isUsageSnapshotStale(
	snapshot: AgentUsageSnapshot | null | undefined,
	compaction: AgentCompactionState | null | undefined,
): boolean {
	return usageFreshness(snapshot, compaction) === "stale_after_compaction";
}

export function deriveUsageSnapshot(
	tokenUsage: ThreadTokenUsage | CurrentContextUsage,
	turnId: string | null,
	updatedAt = Date.now(),
): AgentUsageSnapshot {
	const effectiveUsage = normalizeEffectiveUsage(tokenUsage);
	const tokensUsed = effectiveUsage?.tokensUsed ?? null;
	const tokenLimit = effectiveUsage?.tokenLimit ?? null;
	const usedPercent = tokenLimit && tokenLimit > 0 && tokensUsed !== null
		? Math.round((tokensUsed / tokenLimit) * 100)
		: null;
	return {
		total: "total" in tokenUsage
			? tokenUsage.total
			: {
				totalTokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
		last: "last" in tokenUsage
			? tokenUsage.last
			: {
				totalTokens: tokensUsed ?? 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
		modelContextWindow: "modelContextWindow" in tokenUsage
			? tokenUsage.modelContextWindow
			: tokenLimit,
		turnId,
		tokensUsed,
		tokenLimit,
		remainingTokens: tokenLimit !== null && tokensUsed !== null
			? Math.max(0, tokenLimit - tokensUsed)
			: null,
		usedPercent,
		availablePercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
		updatedAt,
	};
}

export function formatUsageCompact(
	snapshot: AgentUsageSnapshot | null | undefined,
): string {
	if (!snapshot || snapshot.usedPercent === null || snapshot.tokensUsed === null) {
		return "ctx n/a";
	}
	return `${snapshot.usedPercent}% (${formatCompactCount(snapshot.tokensUsed)})`;
}

export function formatCompactionSignal(
	compaction: AgentCompactionState | null | undefined,
): string | null {
	if (!compaction) { return null; }
	if (compaction.inProgress) { return "compacting"; }
	if (compaction.count <= 0) { return null; }
	return "compacted | reseed?";
}

export function formatUsageBreakdown(
	snapshot: AgentUsageSnapshot | null | undefined,
	compaction: AgentCompactionState | null | undefined = null,
): string[] {
	const lines = [`context: ${formatUsageCompact(snapshot)}`];
	if (!snapshot) {
		lines.push("usage snapshot: unavailable");
		return lines;
	}
	lines.push(
		`usage snapshot: used=${formatCount(snapshot.tokensUsed)} limit=${
			formatCount(snapshot.tokenLimit)
		} remaining=${formatCount(snapshot.remainingTokens)} turn=${snapshot.turnId ?? "?"}`,
	);
	if (!compaction) { return lines; }
	if (compaction.inProgress) {
		lines.push(
			`compaction: in progress${compaction.lastTurnId ? ` on turn ${compaction.lastTurnId}` : ""}`,
		);
		return lines;
	}
	if (compaction.count <= 0) { return lines; }
	const freshness = usageFreshness(snapshot, compaction);
	const status = freshness === "post_compaction"
		? "latest usage snapshot arrived after compaction"
		: freshness === "stale_after_compaction"
		? "latest usage snapshot is older than the last compaction"
		: "usage freshness unknown";
	lines.push(
		`compaction: completed ${compaction.count}x${
			compaction.lastTurnId ? ` on turn ${compaction.lastTurnId}` : ""
		}; ${status}`,
	);
	lines.push("action: reseed may be needed after compaction");
	return lines;
}
