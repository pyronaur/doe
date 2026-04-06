import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord } from "../src/state/registry.ts";

function createAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "agent-1",
		name: "Agent 1",
		cwd: "/tmp",
		model: "gpt-5.4",
		state: "working",
		latestSnippet: "latest",
		latestFinalOutput: null,
		lastError: null,
		startedAt: 1,
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		messages: [],
		historyHydratedAt: null,
		...overrides,
	};
}

function attachAgent(registry: DoeRegistry, input: { agentId: string; ic: string; state?: AgentRecord["state"]; threadId?: string }) {
	const seat = registry.assignSeat({ agentId: input.agentId, ic: input.ic });
	registry.upsertAgent(
		createAgent({
			id: input.agentId,
			name: seat.name,
			threadId: input.threadId ?? `${input.agentId}-thread`,
			state: input.state ?? "working",
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
		}),
	);
	return seat;
}

test("default roster queries show only active working seats in bucket order", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony" });
	attachAgent(registry, { agentId: "agent-2", ic: "Peter" });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope" });
	registry.markAwaitingInput("agent-2-thread", "waiting");

	const roster = registry.listRosterAssignments();
	const summaries = registry.getRosterBucketSummaries();

	assert.deepEqual(roster.map((entry) => entry.seat.name), ["Tony", "Hope"]);
	assert.deepEqual(
		summaries.map((entry) => `${entry.bucket}:${entry.activeCount}:${entry.names.join(",")}`),
		[
			"senior:1:Tony",
			"mid:0:",
			"research:1:Hope",
			"contractor:0:",
		],
	);
});

test("roster queries opt in to awaiting-input seats and seat history", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony" });
	attachAgent(registry, { agentId: "agent-2", ic: "Hope" });
	registry.markAwaitingInput("agent-2-thread", "waiting");
	registry.markCompleted("agent-1-thread", "done");

	const roster = registry.listRosterAssignments({ includeAwaitingInput: true, includeHistory: true });
	const summaries = registry.getRosterBucketSummaries({ includeAwaitingInput: true, includeHistory: true });

	assert.deepEqual(
		roster.map((entry) => `${entry.seat.name}:${entry.agent.state}:${entry.source}`),
		["Tony:completed:active", "Hope:awaiting_input:active"],
	);
	assert.deepEqual(
		summaries.map((entry) => `${entry.bucket}:${entry.activeCount}:${entry.names.join(",")}`),
		[
			"senior:1:Tony",
			"mid:0:",
			"research:1:Hope",
			"contractor:0:",
		],
	);
});
