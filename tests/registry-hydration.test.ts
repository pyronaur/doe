import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import { createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

test("hydrateAgentMessages backfills history without overwriting newer live transcript", () => {
	const registry = new DoeRegistry();
	registry.upsertAgent(
		createRegistryAgent({
			threadId: "thread-1",
			messages: [
				{
					turnId: "turn-2",
					itemId: null,
					role: "user",
					text: "follow-up",
					streaming: false,
					createdAt: 20,
					completedAt: 20,
				},
				{
					turnId: "turn-2",
					itemId: "item-2",
					role: "agent",
					text: "newer live output",
					streaming: true,
					createdAt: 21,
					completedAt: null,
				},
			],
			latestSnippet: "newer live output",
		}),
	);

	registry.hydrateAgentMessages("agent-1", [
		{
			turnId: "turn-1",
			itemId: null,
			role: "user",
			text: "initial task",
			streaming: false,
			createdAt: 10,
			completedAt: 10,
		},
		{
			turnId: "turn-1",
			itemId: "item-1",
			role: "agent",
			text: "older context",
			streaming: false,
			createdAt: 11,
			completedAt: 12,
		},
		{
			turnId: "turn-2",
			itemId: null,
			role: "user",
			text: "follow-up",
			streaming: false,
			createdAt: 13,
			completedAt: 13,
		},
		{
			turnId: "turn-2",
			itemId: "item-2",
			role: "agent",
			text: "older snapshot",
			streaming: false,
			createdAt: 14,
			completedAt: 15,
		},
	]);

	const agent = registry.getAgent("agent-1");
	assert.ok(agent);
	assert.equal(agent.messages.length, 4);
	assert.deepEqual(
		agent.messages.map((message) => message.text),
		["initial task", "older context", "follow-up", "newer live output"],
	);
	assert.equal(agent.messages.at(-1)?.streaming, true);
	assert.equal(agent.latestSnippet, "newer live output");
	assert.equal(agent.latestFinalOutput, null);
	assert.ok(agent.historyHydratedAt);
});
