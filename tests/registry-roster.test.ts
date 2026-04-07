import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { PersistedRegistrySnapshot } from "../src/roster/types.ts";
import { attachSeatAgent, createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

test("registry seeds fixed IC roster in role order", () => {
	const registry = new DoeRegistry();
	assert.deepEqual(
		registry.listRosterSeats().map((seat) => `${seat.role}:${seat.name}`),
		[
			"researcher:Tony",
			"researcher:Bruce",
			"senior:Strange",
			"senior:Scott",
			"mid:Peter",
			"mid:Sam",
			"junior:Jane",
			"junior:Pepper",
			"intern:Hope",
		],
	);
});

test("registry keeps seat models on named ICs", () => {
	const registry = new DoeRegistry();
	assert.equal(registry.findSeat("Tony")?.model, "gpt-5.4");
	assert.equal(registry.findSeat("Hope")?.model, "gpt-5.3-codex-spark");
});

test("seat assignment requires an explicit IC or an explicit role", () => {
	const registry = new DoeRegistry();
	assert.throws(
		() => registry.assignSeat({ agentId: "agent-1" }),
		/Seat assignment requires either an explicit IC or an explicit role\./,
	);
});

test("contractor assignments require an explicit model", () => {
	const registry = new DoeRegistry();
	registry.assignSeat({ agentId: "agent-1", role: "mid" });
	registry.assignSeat({ agentId: "agent-2", role: "mid" });
	assert.throws(
		() => registry.assignSeat({ agentId: "agent-3", role: "mid" }),
		/Contractor assignments require an explicit model\./,
	);
});

test("contractor numbering is stable across serialize and restore", () => {
	const registry = new DoeRegistry();
	const peter = registry.assignSeat({ agentId: "agent-1", role: "mid" });
	const sam = registry.assignSeat({ agentId: "agent-2", role: "mid" });
	const contractor1 = registry.assignSeat({ agentId: "agent-3", role: "mid", model: "gpt-5.4" });
	assert.equal(peter.name, "Peter");
	assert.equal(sam.name, "Sam");
	assert.equal(contractor1.name, "contractor-1");

	registry.upsertAgent(
		createRegistryAgent({
			id: "agent-1",
			name: peter.name,
			seatName: peter.name,
			seatRole: peter.role,
		}),
	);
	registry.upsertAgent(
		createRegistryAgent({ id: "agent-2", name: sam.name, seatName: sam.name, seatRole: sam.role }),
	);
	registry.upsertAgent(
		createRegistryAgent({
			id: "agent-3",
			name: contractor1.name,
			seatName: contractor1.name,
			seatRole: contractor1.role,
		}),
	);

	const restored = new DoeRegistry();
	restored.restore(registry.serialize());
	const contractor2 = restored.assignSeat({ agentId: "agent-4", role: "mid", model: "gpt-5.4" });
	assert.equal(contractor2.name, "contractor-2");
});

test("restore rejects contractor seats that are missing a persisted model", () => {
	const registry = new DoeRegistry();
	const invalidSnapshot = {
		version: 6,
		savedAt: Date.now(),
		agents: [],
		batches: [],
		roster: {
			seats: [
				{
					name: "contractor-1",
					role: "contractor",
					activeAgentId: null,
					lastFinishedAgentId: null,
					lastThreadId: null,
					lastFinishNote: null,
					lastReuseSummary: null,
				},
			],
			nextContractorNumber: 2,
		},
	};
	assert.throws(
		() => registry.restore(invalidSnapshot),
		/Stored contractor seat "contractor-1" is missing a model\./,
	);
});

test("completed named seats remain attached until finalize", () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, { agentId: "agent-1", ic: "Tony", threadId: "thread-1" });

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
			createRegistryAgent({ id: "agent-1", name: "Tony", threadId: "thread-1", state: "working" }),
			createRegistryAgent({
				id: "agent-2",
				name: "random worker",
				threadId: "thread-2",
				state: "working",
			}),
			createRegistryAgent({
				id: "agent-3",
				name: "Bruce",
				threadId: "thread-3",
				state: "completed",
				completedAt: 10,
			}),
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
	attachSeatAgent(registry, { agentId: "agent-1", ic: "Hope", threadId: "thread-1" });

	assert.throws(() => registry.finalizeSeat("Hope"), /still working/);
	registry.markCompleted("thread-1", "Need DOE input");
	const finalized = registry.finalizeSeat("Hope", {
		note: "done",
		reuseSummary: "carry forward schema notes",
	});
	assert.equal(finalized.seat.activeAgentId, null);
	assert.equal(finalized.seat.lastFinishNote, "done");
	assert.equal(finalized.agent.state, "finalized");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
});

test("fresh assignment on the same seat requires finalize after completion", () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, { agentId: "agent-1", ic: "Hope", threadId: "thread-1" });
	registry.markCompleted("thread-1", "done");

	assert.throws(
		() => registry.assignSeat({ agentId: "agent-2", ic: "Hope" }),
		/occupied by a completed assignment.*codex_resume.*codex_finalize/,
	);
	registry.finalizeSeat("Hope");
	attachSeatAgent(registry, { agentId: "agent-2", ic: "Hope", threadId: "thread-2" });

	assert.equal(registry.findActiveSeatAgent("Hope")?.id, "agent-2");
	assert.equal(registry.findActiveSeatAgent("Hope")?.threadId, "thread-2");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.threadId, "thread-1");
});

test("restore keeps completed seat attachments name-first without marking them recoverable", () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, { agentId: "agent-1", ic: "Tony", threadId: "thread-1" });
	registry.markCompleted("thread-1", "done");

	const restored = new DoeRegistry();
	restored.restore(registry.serialize());

	assert.equal(restored.findActiveSeatAgent("Tony")?.id, "agent-1");
	assert.equal(restored.findAgent("Tony")?.id, "agent-1");
	assert.deepEqual(restored.listRecoverableAgents().map((agent) => agent.id), []);
});

test("legacy snapshots gain runStartedAt from startedAt during restore", () => {
	const registry = new DoeRegistry();
	registry.restore({
		version: 4,
		savedAt: Date.now(),
		agents: [
			createRegistryAgent({
				id: "agent-1",
				name: "Tony",
				threadId: "thread-1",
				state: "completed",
				startedAt: 123,
				completedAt: 456,
			}),
		],
		batches: [],
	});

	assert.equal(registry.getAgent("agent-1")?.runStartedAt, 123);
});

test("cancelAgent releases the seat and ignores late completion for the interrupted turn", () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: { activeTurnId: "turn-1" },
	});

	const cancelled = registry.cancelAgent("agent-1", {
		note: "Cancelled by Director of Engineering.",
		interruptedTurnId: "turn-1",
	});
	registry.markCompleted("thread-1", "turn-1", "late completion");

	assert.equal(cancelled.state, "finalized");
	assert.equal(registry.findActiveSeatAgent("Hope"), undefined);
	assert.equal(registry.findLastFinishedSeatAgent("Hope")?.id, "agent-1");
	assert.equal(registry.findSeat("Hope")?.activeAgentId, null);
	assert.equal(registry.findSeat("Hope")?.lastFinishNote, "Cancelled by Director of Engineering.");
	assert.equal(registry.getAgent("agent-1")?.state, "finalized");

	const replacement = registry.assignSeat({ agentId: "agent-2", ic: "Hope" });
	assert.equal(replacement.name, "Hope");
});
