import test from "node:test";
import assert from "node:assert/strict";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import {
	formatSpawnAgentResult,
	resolveSpawnRenderBody,
} from "../src/tools/spawn-result.ts";

function createAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: "agent-1",
		name: "Tony",
		model: "gpt-5.4",
		effort: "high",
		state: "completed",
		usage: deriveUsageSnapshot({ tokensUsed: 56_000, tokenLimit: 258_000 }, "turn-1", 1),
		compaction: null,
		latestSnippet: "latest",
		latestFinalOutput: "Implemented the requested change.",
		messages: [],
		...overrides,
	};
}

test("single-agent spawn results include identity, capacity, model, effort, prompt, and final output", () => {
	const text = formatSpawnAgentResult(createAgent(), {
		prompt: "Fix the DOE footer.",
	});

	assert.equal(
		text,
		[
			"ic: Tony",
			"state: completed",
			"capacity: 22%",
			"model: gpt-5.4",
			"effort: high",
			"",
			"prompt:",
			"Fix the DOE footer.",
			"",
			"result:",
			"Implemented the requested change.",
		].join("\n"),
	);
});

test("single-agent spawn render body uses the full tool result instead of a collapsed summary", () => {
	const text = resolveSpawnRenderBody({
		content: [{ type: "text", text: "ic: Tony\nstate: completed\ncapacity: 22%" }],
		details: {
			agents: [createAgent()],
		},
	});

	assert.equal(text, "ic: Tony\nstate: completed\ncapacity: 22%");
});
