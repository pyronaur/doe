import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord } from "../src/state/registry.ts";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import { formatDoeStatus } from "../src/ui/doe-status.ts";

function createAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "agent-1",
		name: "Agent 1",
		cwd: "/tmp",
		model: "gpt-5.4",
		state: "working",
		activityLabel: "thinking",
		latestSnippet: "latest",
		latestFinalOutput: null,
		lastError: null,
		startedAt: 1,
		runStartedAt: 1,
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		messages: [],
		historyHydratedAt: null,
		...overrides,
	};
}

function attachAgent(
	registry: DoeRegistry,
	input: {
		agentId: string;
		ic: string;
		state?: AgentRecord["state"];
		usagePercent?: number;
	},
) {
	const seat = registry.assignSeat({ agentId: input.agentId, ic: input.ic });
	registry.upsertAgent(
		createAgent({
			id: input.agentId,
			name: seat.name,
			threadId: `${input.agentId}-thread`,
			state: input.state ?? "working",
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
			usage: typeof input.usagePercent === "number"
				? deriveUsageSnapshot({ tokensUsed: input.usagePercent, tokenLimit: 100 }, null, 1)
				: null,
		}),
	);
}

test("DOE status expands the bottom summary without the compass emoji", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 60 });
	attachAgent(registry, { agentId: "agent-2", ic: "Strange", usagePercent: 21 });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope", state: "awaiting_input" });
	registry.markAwaitingInput("agent-3-thread", "waiting");

	assert.equal(formatDoeStatus(registry), "3 Active ICs: Tony (60%), Strange (21%)");
});
