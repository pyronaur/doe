import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "./test-runner.ts";

const READ_TOOL_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string" },
	},
	required: ["path"],
	additionalProperties: false,
};

const PI_ROOT = process.env.PI_CODING_AGENT_ROOT
	?? "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent";
const PI_AGENT_CORE_ROOT = process.env.PI_AGENT_CORE_ROOT
	?? join(PI_ROOT, "node_modules/@mariozechner/pi-agent-core");
const PI_AI_ROOT = process.env.PI_AI_ROOT ?? join(PI_ROOT, "node_modules/@mariozechner/pi-ai");
const IS_BUN = typeof Bun !== "undefined";

let piModulesPromise:
	| Promise<{
		createExtensionRuntime: any;
		ExtensionRunner: any;
		agentLoop: any;
		createAssistantMessageEventStream: any;
	}>
	| null = null;

async function loadPiModules() {
	if (piModulesPromise) { return piModulesPromise; }
	piModulesPromise = (async () => {
		if (!existsSync(PI_ROOT)) {
			throw new Error(`Pi package not found at ${PI_ROOT}`);
		}
		const [
			{ createExtensionRuntime },
			{ ExtensionRunner },
			{ agentLoop },
			{ createAssistantMessageEventStream },
		] = await Promise.all([
			import(pathToFileURL(join(PI_ROOT, "dist/core/extensions/loader.js")).href),
			import(pathToFileURL(join(PI_ROOT, "dist/core/extensions/runner.js")).href),
			import(pathToFileURL(join(PI_AGENT_CORE_ROOT, "dist/index.js")).href),
			import(pathToFileURL(join(PI_AI_ROOT, "dist/index.js")).href),
		]);
		return {
			createExtensionRuntime,
			ExtensionRunner,
			agentLoop,
			createAssistantMessageEventStream,
		};
	})();
	return piModulesPromise;
}

function createExtension(
	path: string,
	handler: (event: any, ctx: any) => unknown,
) {
	return {
		path,
		sourceInfo: undefined,
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		messageRenderers: new Map(),
		handlers: new Map([["tool_call", [handler]]]),
	};
}

function createAssistantMessage(
	content: any[],
	stopReason: "toolUse" | "stop" | "error" | "aborted",
) {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: Date.now(),
	};
}

async function createResponse(message: any) {
	const { createAssistantMessageEventStream } = await loadPiModules();
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		}
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			stream.push({
				type: "done",
				reason: message.stopReason,
				message,
			});
		}
		stream.end(message);
	});
	return stream;
}

async function runAgentLoopPreflightCase(input: {
	beforeToolCall: () => Promise<Record<string, unknown>>;
	finalText: string;
}) {
	const { agentLoop } = await loadPiModules();
	let toolExecutions = 0;
	let streamCalls = 0;
	const messages = await agentLoop(
		[{ role: "user", content: "Read the notes file.", timestamp: Date.now() }],
		{
			systemPrompt: "",
			messages: [],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: READ_TOOL_SCHEMA,
					execute: async () => {
						toolExecutions += 1;
						return {
							content: [{ type: "text", text: "tool should not run" }],
							details: {},
						};
					},
				},
			],
		},
		{
			model: { api: "test-api", provider: "test-provider", id: "test-model" },
			convertToLlm: (items: any[]) => items,
			beforeToolCall: input.beforeToolCall,
		},
		undefined,
		async () => {
			streamCalls += 1;
			if (streamCalls === 1) {
				return await createResponse(
					createAssistantMessage(
						[{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
						"toolUse",
					),
				);
			}
			return await createResponse(
				createAssistantMessage([{ type: "text", text: input.finalText }], "stop"),
			);
		},
	).result();

	return { messages, toolExecutions };
}

if (!IS_BUN) {
	test("ExtensionRunner emitToolCall stops at the first immediate toolResult", async () => {
		const { createExtensionRuntime, ExtensionRunner } = await loadPiModules();
		let secondHandlerCalls = 0;
		const toolResult = {
			content: [{ type: "text", text: "denied but continue" }],
		};
		const runner = new ExtensionRunner(
			[
				createExtension("first", async () => ({ toolResult, isError: false })),
				createExtension("second", async () => {
					secondHandlerCalls += 1;
					return { block: true, reason: "should not run" };
				}),
			],
			createExtensionRuntime(),
			process.cwd(),
			{},
			{},
		);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolCallId: "tool-1",
			toolName: "read",
			input: { path: "notes.txt" },
		});

		assert.deepEqual(result, { toolResult, isError: false });
		assert.equal(secondHandlerCalls, 0);
	});
}

if (!IS_BUN) {
	test("agentLoop treats an immediate preflight toolResult as nonfatal and continues the turn", async () => {
		const { messages, toolExecutions } = await runAgentLoopPreflightCase({
			beforeToolCall: async () => ({
				toolResult: {
					content: [{ type: "text", text: "denied but continue" }],
				},
			}),
			finalText: "I will choose another route.",
		});

		const toolResult = messages.find((message) => message.role === "toolResult");
		const finalAssistant = messages.at(-1);

		assert.equal(toolExecutions, 0);
		assert.equal(toolResult?.role, "toolResult");
		assert.equal(toolResult?.isError, false);
		assert.deepEqual(toolResult?.content, [{ type: "text", text: "denied but continue" }]);
		assert.equal(finalAssistant?.role, "assistant");
		assert.deepEqual(finalAssistant?.content, [{
			type: "text",
			text: "I will choose another route.",
		}]);
	});
}

if (!IS_BUN) {
	test("agentLoop still treats blocked preflight results as errors", async () => {
		const { messages, toolExecutions } = await runAgentLoopPreflightCase({
			beforeToolCall: async () => ({
				block: true,
				reason: "blocked on purpose",
			}),
			finalText: "Stopping after the block.",
		});

		const toolResult = messages.find((message) => message.role === "toolResult");

		assert.equal(toolExecutions, 0);
		assert.equal(toolResult?.role, "toolResult");
		assert.equal(toolResult?.isError, true);
		assert.deepEqual(toolResult?.content, [{ type: "text", text: "blocked on purpose" }]);
	});
}
