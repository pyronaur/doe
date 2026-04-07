import assert from "node:assert/strict";
import {
	extractLastCompletedAgentMessage,
	extractThreadFileChanges,
	extractThreadQueryEntries,
} from "../src/codex/client.ts";
import { test } from "./test-runner.ts";

test("extractThreadFileChanges aggregates fileChange items and preserves unavailable stats", () => {
	const thread = {
		turns: [
			{
				id: "turn-1",
				items: [
					{ type: "fileChange", path: "src/a.ts", addedLines: 3, removedLines: 1 },
					{ type: "fileChange", path: "src/a.ts", addedLines: 2, removedLines: 0 },
					{ type: "fileChange", path: "src/b.ts" },
				],
			},
		],
	};

	assert.deepEqual(extractThreadFileChanges(thread), [
		{ path: "src/a.ts", addedLines: 5, removedLines: 1, changes: 2, turnIds: ["turn-1"] },
		{ path: "src/b.ts", addedLines: null, removedLines: null, changes: 1, turnIds: ["turn-1"] },
	]);
});

test("extractThreadQueryEntries includes text, command, and file summaries for targeted lookup", () => {
	const thread = {
		turns: [
			{
				id: "turn-1",
				items: [
					{ id: "u1", type: "userMessage", text: "Investigate auth failure" },
					{ id: "a1", type: "agentMessage", text: "Found the root cause in middleware" },
					{
						id: "c1",
						type: "commandExecution",
						command: "rg auth middleware",
						stdout: "src/auth.ts",
					},
					{ id: "f1", type: "fileChange", path: "src/auth.ts", addedLines: 4, removedLines: 2 },
				],
			},
		],
	};

	assert.deepEqual(extractThreadQueryEntries(thread), [
		{ turnId: "turn-1", itemId: "u1", itemType: "userMessage", text: "Investigate auth failure" },
		{
			turnId: "turn-1",
			itemId: "a1",
			itemType: "agentMessage",
			text: "Found the root cause in middleware",
		},
		{
			turnId: "turn-1",
			itemId: "c1",
			itemType: "commandExecution",
			text: "$ rg auth middleware\nsrc/auth.ts",
		},
		{
			turnId: "turn-1",
			itemId: "f1",
			itemType: "fileChange",
			text: "fileChange src/auth.ts (+4/-2)",
		},
	]);
});

test("extractLastCompletedAgentMessage returns the latest completed agent text", () => {
	const thread = {
		turns: [
			{
				id: "turn-1",
				items: [
					{ type: "userMessage", text: "first" },
					{ type: "agentMessage", text: "older answer" },
				],
			},
			{
				id: "turn-2",
				items: [
					{ type: "userMessage", text: "follow-up" },
					{ type: "agentMessage", text: "newest answer" },
				],
			},
		],
	};

	assert.equal(extractLastCompletedAgentMessage(thread), "newest answer");
});
