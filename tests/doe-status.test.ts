import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";
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
			seatRole: seat.role,
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

	assert.equal(formatDoeStatus(registry), "3 Occupied ICs: Tony[work 60%] | Strange[work 21%] | Hope[wait ?]");
});

test("DOE status keeps all occupied seats visible and hides restored-stale capacity behind a question mark", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 60 });
	attachAgent(registry, { agentId: "agent-2", ic: "Peter", usagePercent: 100 });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope", state: "completed" });
	registry.markAwaitingInput("agent-2-thread", "waiting");
	registry.upsertAgent({
		...registry.findAgent("Peter")!,
		recovered: true,
	});

	assert.equal(formatDoeStatus(registry), "3 Occupied ICs: Tony[work 60%] | Peter[wait ?] | Hope[done ?]");
});

test("DOE status shows restored capacity again after a fresh usage update arrives", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 100 });
	registry.upsertAgent({
		...registry.findAgent("Tony")!,
		recovered: true,
	});

	assert.equal(formatDoeStatus(registry), "1 Occupied IC: Tony[work ?]");

	registry.markTokenUsage("agent-1-thread", "turn-2", { tokensUsed: 42, tokenLimit: 100 });

	assert.equal(formatDoeStatus(registry), "1 Occupied IC: Tony[work 42%]");
});
