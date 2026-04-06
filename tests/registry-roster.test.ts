import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord, PersistedRegistrySnapshot } from "../src/state/registry.ts";

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
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		messages: [],
		historyHydratedAt: null,
		...overrides,
	};
}

test("registry seeds fixed named roster in bucket order", () => {
	const registry = new DoeRegistry();
	assert.deepEqual(
		registry.listRosterSeats().map((seat) => `${seat.bucket}:${seat.name}`),
		[
			"senior:Tony",
			"senior:Bruce",
			"senior:Strange",
			"mid:Peter",
			"mid:Sam",
			"research:Hope",
			"research:Scott",
			"research:Jane",
			"research:Pepper",
		],
	);
});

test("contractor numbering is stable across serialize and restore", () => {
	const registry = new DoeRegistry();
	const peter = registry.assignSeat({ agentId: "agent-1", bucket: "mid" });
	const sam = registry.assignSeat({ agentId: "agent-2", bucket: "mid" });
	const contractor1 = registry.assignSeat({ agentId: "agent-3", bucket: "mid" });
	assert.equal(peter.name, "Peter");
	assert.equal(sam.name, "Sam");
	assert.equal(contractor1.name, "contractor-1");

	registry.upsertAgent(createAgent({ id: "agent-1", name: peter.name, seatName: peter.name, seatBucket: peter.bucket, seatKind: peter.kind }));
	registry.upsertAgent(createAgent({ id: "agent-2", name: sam.name, seatName: sam.name, seatBucket: sam.bucket, seatKind: sam.kind }));
	registry.upsertAgent(createAgent({ id: "agent-3", name: contractor1.name, seatName: contractor1.name, seatBucket: contractor1.bucket, seatKind: contractor1.kind }));

	const restored = new DoeRegistry();
	restored.restore(registry.serialize());
	const contractor2 = restored.assignSeat({ agentId: "agent-4", bucket: "mid" });
	assert.equal(contractor2.name, "contractor-2");
});

test("completed named seats remain attached until finalize", () => {
	const registry = new DoeRegistry();
	const seat = registry.assignSeat({ agentId: "agent-1", ic: "Tony" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: seat.name,
			threadId: "thread-1",
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
		}),
	);

	assert.equal(registry.findActiveSeatAgent("tony")?.id, "agent-1");
	registry.markCompleted("thread-1", "done");
	assert.equal(registry.findActiveSeatAgent("Tony")?.id, "agent-1");
	assert.equal(registry.findLastFinishedSeatAgent("Tony"), undefined);
	assert.equal(registry.findAgent("Tony")?.id, "agent-1");
	assert.equal(registry.findSeat("Tony")?.activeAgentId, "agent-1");
});

test("legacy snapshot restore attaches exact-name completed agents to fixed seats", () => {
	const registry = new DoeRegistry();
	const snapshot: PersistedRegistrySnapshot = {
		version: 3,
		savedAt: Date.now(),
		agents: [
			createAgent({ id: "agent-1", name: "Tony", threadId: "thread-1", state: "working" }),
			createAgent({ id: "agent-2", name: "random worker", threadId: "thread-2", state: "working" }),
			createAgent({ id: "agent-3", name: "Bruce", threadId: "thread-3", state: "completed", completedAt: 10 }),
		],
		batches: [],
	};
	registry.restore(snapshot);

	assert.equal(registry.findSeat("Tony")?.activeAgentId, "agent-1");
	assert.equal(registry.getAgent("agent-1")?.seatName, "Tony");
	assert.equal(registry.getAgent("agent-2")?.seatName, null);
	assert.equal(registry.findSeat("Bruce")?.activeAgentId, "agent-3");
	assert.equal(registry.getAgent("agent-3")?.seatName, "Bruce");
});

test("finalize releases completed seats but rejects active running work", () => {
	const registry = new DoeRegistry();
	const seat = registry.assignSeat({ agentId: "agent-1", ic: "Hope" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: seat.name,
			threadId: "thread-1",
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
		}),
	);

	assert.throws(() => registry.finalizeSeat("Hope"), /still working/);
	registry.markCompleted("thread-1", "Need DOE input");
	const finalized = registry.finalizeSeat("Hope", { note: "done", reuseSummary: "carry forward schema notes" });
	assert.equal(finalized.seat.activeAgentId, null);
	assert.equal(finalized.seat.lastFinishNote, "done");
	assert.equal(finalized.agent.state, "finalized");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
});

test("fresh assignment on the same seat requires finalize after completion", () => {
	const registry = new DoeRegistry();
	const firstSeat = registry.assignSeat({ agentId: "agent-1", ic: "Hope" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: firstSeat.name,
			threadId: "thread-1",
			seatName: firstSeat.name,
			seatBucket: firstSeat.bucket,
			seatKind: firstSeat.kind,
		}),
	);
	registry.markCompleted("thread-1", "done");

	assert.throws(() => registry.assignSeat({ agentId: "agent-2", ic: "Hope" }), /already has an active assignment/);
	registry.finalizeSeat("Hope");
	const secondSeat = registry.assignSeat({ agentId: "agent-2", ic: "Hope" });
	registry.upsertAgent(
		createAgent({
			id: "agent-2",
			name: secondSeat.name,
			threadId: "thread-2",
			seatName: secondSeat.name,
			seatBucket: secondSeat.bucket,
			seatKind: secondSeat.kind,
		}),
	);

	assert.equal(registry.findActiveSeatAgent("Hope")?.id, "agent-2");
	assert.equal(registry.findActiveSeatAgent("Hope")?.threadId, "thread-2");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.threadId, "thread-1");
});

test("restore keeps completed seat attachments name-first without marking them recoverable", () => {
	const registry = new DoeRegistry();
	const seat = registry.assignSeat({ agentId: "agent-1", ic: "Tony" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: seat.name,
			threadId: "thread-1",
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
		}),
	);
	registry.markCompleted("thread-1", "done");

	const restored = new DoeRegistry();
	restored.restore(registry.serialize());

	assert.equal(restored.findActiveSeatAgent("Tony")?.id, "agent-1");
	assert.equal(restored.findAgent("Tony")?.id, "agent-1");
	assert.deepEqual(restored.listRecoverableAgents().map((agent) => agent.id), []);
});
