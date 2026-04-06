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

export interface AgentUsageSnapshot extends ThreadTokenUsage {
	turnId: string | null;
	remainingTokens: number | null;
	usedPercent: number | null;
	availablePercent: number | null;
	updatedAt: number;
}

function formatPercent(value: number | null): string {
	if (value === null) return "?%";
	const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded}%`;
}

export function deriveUsageSnapshot(tokenUsage: ThreadTokenUsage, turnId: string | null, updatedAt = Date.now()): AgentUsageSnapshot {
	const totalTokens = tokenUsage.total.totalTokens;
	const window = tokenUsage.modelContextWindow;
	const remainingTokens = typeof window === "number" && Number.isFinite(window)
		? Math.max(0, window - totalTokens)
		: null;
	const usedPercent = typeof window === "number" && Number.isFinite(window) && window > 0
		? Math.max(0, Math.min(100, (totalTokens / window) * 100))
		: null;
	const availablePercent = usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
	return {
		...tokenUsage,
		turnId,
		remainingTokens,
		usedPercent,
		availablePercent,
		updatedAt,
	};
}

export function formatUsageCompact(snapshot: AgentUsageSnapshot | null | undefined): string {
	if (!snapshot) return "ctx n/a";
	const total = snapshot.total.totalTokens.toLocaleString();
	const window = snapshot.modelContextWindow?.toLocaleString() ?? "?";
	return `ctx ${formatPercent(snapshot.usedPercent)} used | ${formatPercent(snapshot.availablePercent)} free | ${total}/${window}`;
}

export function formatUsageBreakdown(snapshot: AgentUsageSnapshot | null | undefined): string[] {
	if (!snapshot) return ["context: n/a"];
	return [
		`context: ${formatUsageCompact(snapshot)}`,
		`tokens total=${snapshot.total.totalTokens.toLocaleString()} input=${snapshot.total.inputTokens.toLocaleString()} cached=${snapshot.total.cachedInputTokens.toLocaleString()} output=${snapshot.total.outputTokens.toLocaleString()} reasoning=${snapshot.total.reasoningOutputTokens.toLocaleString()}`,
		`last turn tokens input=${snapshot.last.inputTokens.toLocaleString()} cached=${snapshot.last.cachedInputTokens.toLocaleString()} output=${snapshot.last.outputTokens.toLocaleString()} reasoning=${snapshot.last.reasoningOutputTokens.toLocaleString()} total=${snapshot.last.totalTokens.toLocaleString()}`,
	];
}
