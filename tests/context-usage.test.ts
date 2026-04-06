import test from "node:test";
import assert from "node:assert/strict";
import { deriveUsageSnapshot, formatCompactionSignal, formatUsageCompact } from "../src/context-usage.ts";

test("formatUsageCompact renders current effective usage as percent and token count", () => {
	const snapshot = deriveUsageSnapshot({ tokensUsed: 204_000, tokenLimit: 258_000 }, "turn-1", 1);
	assert.equal(formatUsageCompact(snapshot), "79% (204k)");
});

test("deriveUsageSnapshot prefers last-turn usage from legacy token payloads", () => {
	const snapshot = deriveUsageSnapshot(
		{
			total: {
				totalTokens: 454_559,
				inputTokens: 423_762,
				cachedInputTokens: 346_496,
				outputTokens: 30_797,
				reasoningOutputTokens: 24_276,
			},
			last: {
				totalTokens: 41_669,
				inputTokens: 41_625,
				cachedInputTokens: 41_344,
				outputTokens: 44,
				reasoningOutputTokens: 12,
			},
			modelContextWindow: 258_400,
		},
		"turn-1",
		1,
	);

	assert.equal(snapshot.tokensUsed, 41_669);
	assert.equal(snapshot.tokenLimit, 258_400);
	assert.equal(snapshot.usedPercent, 16);
	assert.equal(formatUsageCompact(snapshot), "16% (41.7k)");
});

test("formatCompactionSignal preserves reseed signaling outside the main metric", () => {
	const signal = formatCompactionSignal({
		inProgress: false,
		count: 1,
		lastStartedAt: 1,
		lastCompletedAt: 2,
		lastTurnId: "turn-1",
		lastItemId: "item-1",
		lastSignal: "contextCompaction",
	});
	assert.equal(signal, "compacted | reseed?");
});
