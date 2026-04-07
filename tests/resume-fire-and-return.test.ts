import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import { attachSeatAgent, requireRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";
import { mockToolModules } from "./tool-module-mocks.ts";

mockToolModules({
	includeContainer: true,
	includePiAi: true,
	includeTypeboxCollections: true,
});

const { registerResumeTool } = await import("../src/tools/resume.ts");

class FakeResumeClient {
	resumeCalls: Array<Record<string, unknown>> = [];
	turnCalls: Array<Record<string, unknown>> = [];
	steerCalls: Array<{ threadId: string; expectedTurnId: string; prompt: string }> = [];
	private nextTurn = 0;

	async resumeThread(options: Record<string, unknown>) {
		this.resumeCalls.push(options);
	}

	async startTurn(options: Record<string, unknown>) {
		this.turnCalls.push(options);
		this.nextTurn += 1;
		return { turn: { id: `turn-${this.nextTurn}` } };
	}

	async steerTurn(input: { threadId: string; expectedTurnId: string; prompt: string }) {
		this.steerCalls.push(input);
	}
}

async function createResumeTool(registry: DoeRegistry, client: FakeResumeClient) {
	const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<any> }>();
	const pi = {
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<any> }) {
			tools.set(tool.name, tool);
		},
	};

	Reflect.apply(registerResumeTool, undefined, [pi, {
		client,
		registry,
		templatesDir: process.cwd(),
		getSessionSlug: () => "feature-x",
	}]);

	const tool = tools.get("codex_resume");
	if (!tool) {
		throw new Error("Missing tool \"codex_resume\".");
	}
	return tool;
}

test("codex_resume returns immediately when steer is queued on an active turn", async () => {
	const registry = new DoeRegistry();
	const client = new FakeResumeClient();
	const tool = await createResumeTool(registry, client);
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: {
			id: "agent-1",
			state: "working",
			activeTurnId: "turn-active",
		},
	});

	const result = await tool.execute(
		"tool-call-1",
		{
			ic: "Hope",
			prompt: "Apply the small follow-up change.",
		},
		undefined,
		undefined,
		undefined,
	);

	assert.equal(client.steerCalls.length, 1);
	assert.equal(client.resumeCalls.length, 0);
	assert.equal(client.turnCalls.length, 0);
	assert.equal(result.details.action, "steer_queued");
	assert.match(String(result.content?.[0]?.text ?? ""), /action: steer_queued/);
	assert.equal(requireRegistryAgent(registry, "agent-1").state, "working");
});

test("codex_resume returns immediately after starting a new turn", async () => {
	const registry = new DoeRegistry();
	const client = new FakeResumeClient();
	const tool = await createResumeTool(registry, client);
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: {
			id: "agent-1",
			state: "completed",
			activeTurnId: null,
			completedAt: Date.now(),
		},
	});

	const result = await Promise.race([
		tool.execute(
			"tool-call-2",
			{
				ic: "Hope",
				prompt: "Start the next turn on this thread.",
			},
			undefined,
			undefined,
			undefined,
		),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Timed out waiting for resume.")), 200)
		),
	]);

	assert.equal(client.steerCalls.length, 0);
	assert.equal(client.resumeCalls.length, 1);
	assert.equal(client.turnCalls.length, 1);
	assert.equal(result.details.action, "turn_started");
	assert.match(String(result.content?.[0]?.text ?? ""), /action: turn_started/);
	assert.equal(requireRegistryAgent(registry, "agent-1").state, "working");
});
