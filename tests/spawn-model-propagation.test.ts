import assert from "node:assert/strict";
import { DoeRegistry } from "../src/roster/registry.ts";
import { test } from "./test-runner.ts";
import { mockToolModules } from "./tool-module-mocks.ts";

mockToolModules({
	includeContainer: true,
	includePiAi: true,
	includeTypeboxCollections: true,
});

const { registerSpawnTool } = await import("../src/tools/spawn.ts");

class FakeSpawnClient {
	threadCalls: Array<Record<string, unknown>> = [];
	turnCalls: Array<Record<string, unknown>> = [];
	private nextThread = 0;
	private nextTurn = 0;
	private readonly registry: DoeRegistry;

	constructor(registry: DoeRegistry) {
		this.registry = registry;
	}

	async startThread(options: Record<string, unknown>) {
		this.threadCalls.push(options);
		this.nextThread += 1;
		return { thread: { id: `thread-${this.nextThread}` } };
	}

	async startTurn(options: Record<string, unknown>) {
		this.turnCalls.push(options);
		this.nextTurn += 1;
		const turnId = `turn-${this.nextTurn}`;
		setTimeout(() => {
			this.registry.markCompleted(String(options.threadId), turnId, `Completed ${turnId}`);
		}, 0);
		return { turn: { id: turnId } };
	}
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

function getRegisteredTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`Missing tool "${name}".`);
	}
	return tool;
}

async function createSpawnTool(registry: DoeRegistry, client: FakeSpawnClient) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	};

	Reflect.apply(registerSpawnTool, undefined, [pi, {
		client,
		registry,
		templatesDir: process.cwd(),
		getSessionSlug: () => "feature-x",
	}]);

	return getRegisteredTool(tools, "codex_spawn");
}

test("codex_spawn inherits the assigned seat model and forwards it through thread/start", async () => {
	const registry = new DoeRegistry();
	const client = new FakeSpawnClient(registry);
	const spawnTool = await createSpawnTool(registry, client);

	const result = await spawnTool.execute(
		"tool-call-1",
		{
			ic: "Tony",
			prompt: "Investigate why model defaults are not propagating.",
			cwd: "/tmp",
		},
		undefined,
		undefined,
		undefined,
	);

	assert.equal(registry.findSeat("Tony")?.model, "gpt-5.4");
	assert.equal(client.threadCalls[0]?.model, "gpt-5.4");
	assert.equal(client.turnCalls[0]?.model, "gpt-5.4");
	assert.equal(result.details.agents[0]?.model, "gpt-5.4");
});

test("codex_spawn requires an explicit role for auto-allocation", async () => {
	const registry = new DoeRegistry();
	const client = new FakeSpawnClient(registry);
	const spawnTool = await createSpawnTool(registry, client);

	await assert.rejects(
		() =>
			spawnTool.execute(
				"tool-call-2",
				{
					prompt: "Take the task without a role.",
					cwd: "/tmp",
				},
				undefined,
				undefined,
				undefined,
			),
		/Seat assignment requires either an explicit IC or an explicit role\./,
	);
	assert.equal(client.threadCalls.length, 0);
});

test("codex_spawn requires an explicit or template-supplied model when overflow needs a contractor", async () => {
	const registry = new DoeRegistry();
	registry.assignSeat({ agentId: "existing-1", role: "mid" });
	registry.assignSeat({ agentId: "existing-2", role: "mid" });
	registry.assignSeat({ agentId: "existing-3", role: "mid", model: "gpt-5.4" });
	const client = new FakeSpawnClient(registry);
	const spawnTool = await createSpawnTool(registry, client);

	await assert.rejects(
		() =>
			spawnTool.execute(
				"tool-call-3",
				{
					role: "mid",
					prompt: "Take the overflow task.",
					cwd: "/tmp",
				},
				undefined,
				undefined,
				undefined,
			),
		/Contractor assignments require an explicit model\./,
	);
	assert.equal(client.threadCalls.length, 0);
});
