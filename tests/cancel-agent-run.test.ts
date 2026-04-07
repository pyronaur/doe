import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import { cancelAgentRun } from "../src/tools/cancel-agent-run.ts";
import { attachSeatAgent, requireRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

test("cancelAgentRun interrupts, unsubscribes, and releases the seat by default", async () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: {
			activeTurnId: "turn-1",
			runStartedAt: 1,
		},
	});

	const calls: string[] = [];
	const client = {
		async interruptTurn(threadId: string, turnId: string) {
			calls.push(`interrupt:${threadId}:${turnId}`);
		},
		async unsubscribeThread(threadId: string) {
			calls.push(`unsubscribe:${threadId}`);
		},
	};

	const updated = await cancelAgentRun({
		agent: requireRegistryAgent(registry, "agent-1"),
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
