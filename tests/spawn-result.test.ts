import assert from "node:assert/strict";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import {
	formatSpawnAgentResult,
	resolveSpawnRenderBody,
} from "../src/tools/spawn-result.ts";
import { test } from "./test-runner.ts";

function createAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: "agent-1",
		name: "Tony",
		model: "gpt-5.4",
		effort: "high",
		threadId: "thread-1",
		state: "working",
		usage: deriveUsageSnapshot({ tokensUsed: 56_000, tokenLimit: 258_000 }, "turn-1", 1),
		compaction: null,
		latestSnippet: "latest",
		latestFinalOutput: null,
		messages: [],
		...overrides,
	};
}

test("single-agent spawn results include launch identity, prompt, and next steps", () => {
	const text = formatSpawnAgentResult(createAgent(), {
		prompt: "Fix the DOE footer.",
	});

	assert.equal(
		text,
		[
			"ic: Tony",
			"agent_id: agent-1",
			"thread_id: thread-1",
			"state: working",
			"capacity: 22%",
			"model: gpt-5.4",
			"effort: high",
			"",
			"prompt:",
			"Fix the DOE footer.",
			"",
			"next_step:",
			"Worker launched and running in the background. Use codex_resume to steer, and use codex_list or codex_inspect to monitor progress.",
		].join("\n"),
	);
});

test("single-agent spawn render body uses the full tool result instead of a collapsed summary", () => {
	const text = resolveSpawnRenderBody({
		content: [{ type: "text", text: "ic: Tony\nstate: working\ncapacity: 22%" }],
		details: {
			agents: [createAgent()],
		},
	});

	assert.equal(text, "ic: Tony\nstate: working\ncapacity: 22%");
});

test("single-agent spawn result strips shared session context preamble from displayed prompt", () => {
	const text = formatSpawnAgentResult(createAgent(), {
		prompt: [
			"Shared session context:",
			"- Session slug: doe-roster-ui",
			"- Shared knowledgebase directory: /Users/n14/.n/.tmp/doe-roster-ui",
			"- Reuse that shared directory for any notes or artifacts that belong to this DoE session.",
			"",
			"Implement the roster card fix.",
		].join("\n"),
	});

	assert.match(text, /prompt:\nImplement the roster card fix\./);
	assert.doesNotMatch(text, /Shared session context:/);
});

test("single-agent spawn result does not include a final result section", () => {
	const text = formatSpawnAgentResult(
		createAgent({
			latestFinalOutput: "queued: Shared session context: ...",
			latestSnippet: "queued: Shared session context: ...",
			messages: [],
		}),
		{ prompt: "Investigate why cards show queued output." },
	);

	assert.match(text, /next_step:\nWorker launched and running in the background\./);
	assert.doesNotMatch(text, /result:/);
});
