import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";

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
			seatRole: seat.role,
		}),
	);
	return seat;
}

test("default roster queries show occupied seats in role order", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony" });
	attachAgent(registry, { agentId: "agent-2", ic: "Peter" });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope" });
	registry.markAwaitingInput("agent-2-thread", "waiting");
	registry.markCompleted("agent-3-thread", "done");

	const roster = registry.listRosterAssignments();
	const summaries = registry.getRosterRoleSummaries();

	assert.deepEqual(roster.map((entry) => `${entry.seat.name}:${entry.agent.state}:${entry.source}`), [
		"Tony:working:active",
		"Peter:awaiting_input:active",
		"Hope:completed:active",
	]);
	assert.deepEqual(
		summaries.map((entry) => `${entry.role}:${entry.activeCount}:${entry.names.join(",")}`),
		[
			"researcher:1:Tony",
			"senior:0:",
			"mid:1:Peter",
			"junior:0:",
			"intern:1:Hope",
			"contractor:0:",
		],
	);
});

test("roster history opts in released seats while default remains occupied-only", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony" });
	attachAgent(registry, { agentId: "agent-2", ic: "Hope" });
	registry.markCompleted("agent-1-thread", "done");
	registry.finalizeSeat("Tony");
	registry.markAwaitingInput("agent-2-thread", "waiting");

	const occupied = registry.listRosterAssignments();
	const roster = registry.listRosterAssignments({ includeHistory: true });
	const summaries = registry.getRosterRoleSummaries({ includeHistory: true });

	assert.deepEqual(
		occupied.map((entry) => `${entry.seat.name}:${entry.agent.state}:${entry.source}`),
		["Hope:awaiting_input:active"],
	);

	assert.deepEqual(
		roster.map((entry) => `${entry.seat.name}:${entry.agent.state}:${entry.source}`),
		["Tony:finalized:history", "Hope:awaiting_input:active"],
	);
	assert.deepEqual(
		summaries.map((entry) => `${entry.role}:${entry.activeCount}:${entry.names.join(",")}`),
		[
			"researcher:1:Tony",
			"senior:0:",
			"mid:0:",
			"junior:0:",
			"intern:1:Hope",
			"contractor:0:",
		],
	);
});
