import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord } from "../src/state/registry.ts";
import { formatOccupiedWidget } from "../src/ui/occupied-widget.ts";

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
		activityLabel?: AgentRecord["activityLabel"];
	},
) {
	const seat = registry.assignSeat({ agentId: input.agentId, ic: input.ic });
	registry.upsertAgent(
		createAgent({
			id: input.agentId,
			name: seat.name,
			threadId: `${input.agentId}-thread`,
			state: input.state ?? "working",
			activityLabel: input.activityLabel ?? (input.state === "completed" ? "completed" : "thinking"),
			seatName: seat.name,
			seatBucket: seat.bucket,
			seatKind: seat.kind,
		}),
	);
}

test("occupied widget hides while any IC is actively working", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Scott" });

	assert.deepEqual(formatOccupiedWidget(registry, "ctrl+,"), []);
});

test("occupied widget still shows non-working occupied seats", () => {
	const registry = new DoeRegistry();
	const now = Date.now();
	attachAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		state: "completed",
		activityLabel: "completed",
	});
	registry.upsertAgent({
		...registry.getAgent("agent-1")!,
		startedAt: now,
		runStartedAt: now,
	});
	registry.markCompleted("agent-1-thread", "done");

	const lines = formatOccupiedWidget(registry, "ctrl+,");
	assert.equal(lines[0], "DoE Occupied Roster (1)");
	assert.equal(lines[1], "Researchers/Assistants: Hope");
	assert.match(lines[2] ?? "", /^1\. Hope completed \(0m 0\ds\)$/);
	assert.equal(lines[3], "ctrl+, monitor");
});

test("occupied widget hides cancelled awaiting-input seats", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		state: "awaiting_input",
		activityLabel: "awaiting input",
	});
	registry.upsertAgent({
		...registry.getAgent("agent-1")!,
		latestSnippet: "Interrupted by Director of Engineering.",
	});

	assert.deepEqual(formatOccupiedWidget(registry, "ctrl+,"), []);
});

test("occupied widget hides completed seats that ended in operation aborted", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		state: "completed",
		activityLabel: "completed",
	});
	registry.upsertAgent({
		...registry.getAgent("agent-1")!,
		latestFinalOutput: "Operation aborted",
		latestSnippet: "Operation aborted",
	});

	assert.deepEqual(formatOccupiedWidget(registry, "ctrl+,"), []);
});
