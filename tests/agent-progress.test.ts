import assert from "node:assert/strict";
import {
	formatAgentProgressLine,
	formatAgentProgressSummary,
	resolveRunStartedAt,
} from "../src/ui/agent-progress.ts";
import { test } from "./test-runner.ts";

test("progress line uses runStartedAt so resume timing resets independently from thread lifetime", () => {
	const line = formatAgentProgressLine(
		{
			name: "Jane",
			state: "working",
			activityLabel: "thinking",
			usage: {
				total: {
					totalTokens: 0,
					inputTokens: 0,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				last: {
					totalTokens: 0,
					inputTokens: 0,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				modelContextWindow: 258_000,
				turnId: "turn-1",
				tokensUsed: 56_000,
				tokenLimit: 258_000,
				remainingTokens: 202_000,
				usedPercent: 22,
				availablePercent: 78,
				updatedAt: 180_000,
			},
			startedAt: 0,
			runStartedAt: 36_000,
			completedAt: null,
		},
		{ now: 180_000 },
	);

	assert.equal(line, "Jane thinking... (22% (56k) - 2m 24s)");
});

test("progress line omits missing usage placeholders", () => {
	const line = formatAgentProgressLine(
		{
			name: "Tony",
			state: "working",
			activityLabel: "thinking",
			usage: null,
			startedAt: 0,
			runStartedAt: 61_000,
			completedAt: null,
		},
		{ now: 181_000 },
	);

	assert.equal(line, "Tony thinking... (2m 00s)");
});

test("progress summary joins active IC lines compactly", () => {
	const summary = formatAgentProgressSummary(
		[
			{
				name: "Jane",
				state: "working",
				activityLabel: "thinking",
				usage: null,
				startedAt: 0,
				runStartedAt: 60_000,
				completedAt: null,
			},
			{
				name: "Tony",
				state: "awaiting_input",
				activityLabel: "awaiting input",
				usage: null,
				startedAt: 0,
				runStartedAt: 120_000,
				completedAt: 180_000,
			},
		],
		{ now: 180_000 },
	);

	assert.equal(summary, "Jane thinking... (2m 00s) | Tony awaiting input (1m 00s)");
});

test("runStartedAt falls back to startedAt for legacy snapshots", () => {
	assert.equal(resolveRunStartedAt({ startedAt: 12_345, runStartedAt: null }), 12_345);
	assert.equal(resolveRunStartedAt({ startedAt: 12_345 }), 12_345);
});
