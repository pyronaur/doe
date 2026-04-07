import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord } from "../src/types.ts";
import { cancelAgentRun } from "../src/tools/cancel-agent-run.ts";

function createAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "agent-1",
		name: "Agent 1",
		cwd: "/tmp",
		model: "gpt-5.4",
		state: "working",
		latestSnippet: "",
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

test("cancelAgentRun interrupts, unsubscribes, and releases the seat by default", async () => {
	const registry = new DoeRegistry();
	const seat = registry.assignSeat({ agentId: "agent-1", ic: "Hope" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: seat.name,
			threadId: "thread-1",
			activeTurnId: "turn-1",
			seatName: seat.name,
			seatRole: seat.role,
		}),
	);

	const calls: string[] = [];
	const client = {
		async interruptTurn(threadId: string, turnId: string) {
			calls.push(`interrupt:${threadId}:${turnId}`);
		},
		async unsubscribeThread(threadId: string) {
			calls.push(`unsubscribe:${threadId}`);
		},
	} as any;

	const updated = await cancelAgentRun({
		agent: registry.getAgent("agent-1")!,
		client,
		registry,
		note: "Cancelled by Director of Engineering.",
	});

	assert.deepEqual(calls, ["interrupt:thread-1:turn-1", "unsubscribe:thread-1"]);
	assert.equal(updated.state, "finalized");
	assert.equal(registry.findActiveSeatAgent("Hope"), undefined);
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
	assert.equal(registry.findSeat("Hope")?.lastFinishNote, "Cancelled by Director of Engineering.");
	assert.deepEqual(registry.listRecoverableAgents().map((agent) => agent.id), []);
});
