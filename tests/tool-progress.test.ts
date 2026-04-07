import assert from "node:assert/strict";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import {
	buildToolProgressUpdate,
	readToolProgressSummary,
	startToolProgressUpdates,
} from "../src/tools/progress-updates.ts";
import { createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

test("buildToolProgressUpdate summarizes only live working agents", () => {
	const registry = new DoeRegistry();
	const now = Date.now();
	registry.upsertAgent(
		createRegistryAgent({
			id: "agent-1",
			name: "Jane",
			activityLabel: "thinking",
			latestSnippet: "latest",
			usage: deriveUsageSnapshot({ tokensUsed: 56_000, tokenLimit: 258_000 }, "turn-1", 1),
			startedAt: now - 10_000,
			runStartedAt: now - 10_000,
		}),
	);
	registry.upsertAgent(
		createRegistryAgent({
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
		createRegistryAgent({
			id: "agent-1",
			name: "Jane",
			activityLabel: "thinking",
			latestSnippet: "latest",
			runStartedAt: Date.now() - 5_000,
		}),
	);
	registry.upsertAgent(
		createRegistryAgent({
			id: "agent-2",
			name: "Tony",
			activityLabel: "thinking",
			latestSnippet: "latest",
			runStartedAt: Date.now() - 15_000,
		}),
	);
	registry.upsertAgent(
		createRegistryAgent({
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
	assert.match(updates[2] ?? "",
		/^Jane thinking\.\.\. \(0m 0\ds\) \| Tony thinking\.\.\. \(0m 1\ds\)$/);
	assert.match(updates[3] ?? "", /^Tony thinking\.\.\. \(0m 1\ds\)$/);
	assert.deepEqual(workingMessages, updates);
	assert.equal(stopped, true);
});

test("readToolProgressSummary prefers structured partial details", () => {
	assert.equal(
		readToolProgressSummary({ details: { progressSummary: "Jane thinking... (2m 24s)" } }),
		"Jane thinking... (2m 24s)",
	);
	assert.equal(readToolProgressSummary({ details: { progressSummary: "" } }), null);
});
