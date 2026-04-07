import test from "node:test";
import assert from "node:assert/strict";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import { DoeRegistry } from "../src/state/registry.ts";
import type { AgentRecord } from "../src/types.ts";
import { buildToolProgressUpdate, readToolProgressSummary, startToolProgressUpdates } from "../src/tools/progress-updates.ts";

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

test("buildToolProgressUpdate summarizes only live working agents", () => {
	const registry = new DoeRegistry();
	const now = Date.now();
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: "Jane",
			usage: deriveUsageSnapshot({ tokensUsed: 56_000, tokenLimit: 258_000 }, "turn-1", 1),
			startedAt: now - 10_000,
			runStartedAt: now - 10_000,
		}),
	);
	registry.upsertAgent(
		createAgent({
			id: "agent-2",
			name: "Tony",
			state: "completed",
			activityLabel: "completed",
			startedAt: 1,
			runStartedAt: 61_000,
			completedAt: 121_000,
		}),
	);

	const update = buildToolProgressUpdate(registry, ["agent-1", "agent-2"]);
	assert.equal(update.activeAgents.map((agent) => agent.id).join(","), "agent-1");
	assert.match(update.progressSummary, /^Jane thinking\.\.\. \(22% \(56k\) - 0m 1\ds\)$/);
});

test("startToolProgressUpdates streams refreshed summaries as registry state changes", () => {
	const registry = new DoeRegistry();
	const updates: string[] = [];
	const workingMessages: string[] = [];
	let stopped = false;
	const stop = startToolProgressUpdates({
		registry,
		agentIds: ["agent-1", "agent-2"],
		onUpdate(update) {
			updates.push(update.content[0].text);
		},
		onProgressSummary(summary) {
			workingMessages.push(summary);
		},
		onStop() {
			stopped = true;
		},
	});

	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: "Jane",
			runStartedAt: Date.now() - 5_000,
		}),
	);
	registry.upsertAgent(
		createAgent({
			id: "agent-2",
			name: "Tony",
			runStartedAt: Date.now() - 15_000,
		}),
	);
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: "Jane",
			threadId: "thread-1",
			state: "completed",
			activityLabel: "completed",
			completedAt: Date.now(),
			runStartedAt: Date.now() - 5_000,
		}),
	);

	stop();

	assert.equal(updates[0], "Launching ICs...");
	assert.match(updates[1] ?? "", /^Jane thinking\.\.\. \(0m 0\ds\)$/);
	assert.match(updates[2] ?? "", /^Jane thinking\.\.\. \(0m 0\ds\) \| Tony thinking\.\.\. \(0m 1\ds\)$/);
	assert.match(updates[3] ?? "", /^Tony thinking\.\.\. \(0m 1\ds\)$/);
	assert.deepEqual(workingMessages, updates);
	assert.equal(stopped, true);
});

test("readToolProgressSummary prefers structured partial details", () => {
	assert.equal(readToolProgressSummary({ details: { progressSummary: "Jane thinking... (2m 24s)" } }), "Jane thinking... (2m 24s)");
	assert.equal(readToolProgressSummary({ details: { progressSummary: "" } }), null);
});
