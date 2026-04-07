import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";
import { createEmptyPlanState, type DoePlanState } from "../src/plan/session-state.ts";

mock.module("@sinclair/typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: () => ({ type: "string" }),
		Optional: (value: unknown) => value,
		Boolean: () => ({ type: "boolean" }),
	},
}));

mock.module("@mariozechner/pi-tui", () => ({
	Text: class Text {
		constructor(
			public readonly text: string,
			public readonly x = 0,
			public readonly y = 0,
		) {}
	},
}));

mock.module("@mariozechner/pi-coding-agent", () => ({}));

let planToolModules:
	| {
		registerPlanResumeTool: typeof import("../src/tools/plan-resume.ts").registerPlanResumeTool;
		registerPlanStartTool: typeof import("../src/tools/plan-start.ts").registerPlanStartTool;
		registerPlanStopTool: typeof import("../src/tools/plan-stop.ts").registerPlanStopTool;
	}
	| null = null;

async function loadPlanTools() {
	if (planToolModules) return planToolModules;
	const [{ registerPlanResumeTool }, { registerPlanStartTool }, { registerPlanStopTool }] = await Promise.all([
		import("../src/tools/plan-resume.ts"),
		import("../src/tools/plan-start.ts"),
		import("../src/tools/plan-stop.ts"),
	]);
	planToolModules = {
		registerPlanResumeTool,
		registerPlanStartTool,
		registerPlanStopTool,
	};
	return planToolModules;
}

function createPlanTemplate(templatesDir: string) {
	mkdirSync(templatesDir, { recursive: true });
	writeFileSync(
		join(templatesDir, "plan.md"),
		[
			"---",
			"default_model: gpt-5.4-mini",
			"default_effort: high",
			"---",
			"Shared knowledgebase directory: {{sharedKnowledgebasePath}}",
			"Write the plan only to: {{planFilePath}}",
			"",
			"Task:",
			"{{task}}",
			"",
		].join("\n"),
		"utf-8",
	);
}

function createAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "agent-1",
		name: "Hope",
		cwd: "/tmp",
		model: "gpt-5.4",
		effort: "medium",
		template: "plan",
		allowWrite: true,
		threadId: "thread-1",
		activeTurnId: "turn-1",
		state: "working",
		activityLabel: "thinking",
		latestSnippet: "",
		latestFinalOutput: null,
		lastError: null,
		usage: null,
		compaction: null,
		startedAt: 1,
		runStartedAt: 1,
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		completionNotified: false,
		recovered: false,
		seatName: "Hope",
		seatRole: "research",
		finishNote: null,
		reuseSummary: null,
		messages: [],
		historyHydratedAt: null,
		...overrides,
	};
}

function extractPlanFilePath(prompt: string): string {
	const match = prompt.match(/(?:Write the plan only to|Rewrite the plan only at):\s*(.+)$/m);
	assert.ok(match?.[1], `missing plan file path in prompt:\n${prompt}`);
	return match[1]!.trim();
}

class FakePlanClient {
	threadCalls: Array<Record<string, unknown>> = [];
	turnCalls: Array<{ threadId: string; prompt: string }> = [];
	resumeCalls: Array<Record<string, unknown>> = [];
	interruptCalls: Array<{ threadId: string; turnId: string }> = [];
	steerCalls: Array<{ threadId: string; expectedTurnId: string; prompt: string }> = [];
	private nextThread = 0;
	private nextTurn = 0;

	constructor(
		private readonly registry: DoeRegistry,
		private readonly planBodies: string[],
	) {}

	async startThread(options: Record<string, unknown>) {
		this.threadCalls.push(options);
		this.nextThread += 1;
		return { thread: { id: `thread-${this.nextThread}` } };
	}

	async startTurn(input: { threadId: string; prompt: string }) {
		this.turnCalls.push(input);
		this.nextTurn += 1;
		const turnId = `turn-${this.nextTurn}`;
		writeFileSync(extractPlanFilePath(input.prompt), this.planBodies.shift() ?? "# Draft\n", "utf-8");
		setTimeout(() => {
			this.registry.markCompleted(input.threadId, turnId, `Completed ${turnId}`);
		}, 0);
		return { turn: { id: turnId } };
	}

	async resumeThread(options: Record<string, unknown>) {
		this.resumeCalls.push(options);
	}

	async steerTurn(input: { threadId: string; expectedTurnId: string; prompt: string }) {
		this.steerCalls.push(input);
		writeFileSync(extractPlanFilePath(input.prompt), this.planBodies.shift() ?? "# Revised\n", "utf-8");
		setTimeout(() => {
			this.registry.markCompleted(input.threadId, input.expectedTurnId, `Completed ${input.expectedTurnId}`);
		}, 0);
	}

	async interruptTurn(threadId: string, turnId: string) {
		this.interruptCalls.push({ threadId, turnId });
	}
}

class FailingStartThreadClient extends FakePlanClient {
	override async startThread(_options: Record<string, unknown>) {
		throw new Error("startThread failed");
	}
}

async function createToolHarness(input: {
	registry: DoeRegistry;
	client: FakePlanClient;
	templatesDir: string;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState) => DoePlanState;
}) {
	const { registerPlanResumeTool, registerPlanStartTool, registerPlanStopTool } = await loadPlanTools();
	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as any;

	registerPlanStartTool(pi, {
		client: input.client as any,
		registry: input.registry,
		templatesDir: input.templatesDir,
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	});
	registerPlanResumeTool(pi, {
		client: input.client as any,
		registry: input.registry,
		templatesDir: input.templatesDir,
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	});
	registerPlanStopTool(pi, {
		client: input.client as any,
		registry: input.registry,
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	});

	return {
		start: tools.get("plan_start"),
		resume: tools.get("plan_resume"),
		stop: tools.get("plan_stop"),
	};
}

test("plan_start requires an explicit IC, writes the plan file, and returns the manual annotate step", { concurrency: false }, async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const registry = new DoeRegistry();
	const client = new FakePlanClient(registry, ["# Draft\n\nInitial plan.\n"]);
	let planState = createEmptyPlanState();
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir,
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});
	const previousCwd = process.cwd();
	process.chdir(repoRoot);

	try {
		const result = await tools.start.execute("tool-1", {
			ic: "Hope",
			planSlug: "auth refactor",
			prompt: "Plan the auth rewrite.",
		}, undefined);

		const planFilePath = planState.activePlan?.planFilePath ?? "";
		assert.equal(planState.activePlan?.ic, "Hope");
		assert.match(planFilePath, /\/\.tmp\/feature-x\/plan-auth-refactor\.md$/);
		assert.equal(planState.activePlan?.threadId, "thread-1");
		assert.ok(existsSync(planFilePath));
		assert.match(readFileSync(planFilePath, "utf-8"), /Initial plan/);
		assert.equal(client.threadCalls[0]?.model, "gpt-5.4-mini");
		assert.equal((client.turnCalls as Array<{ threadId: string; prompt: string } | undefined>)[0] ? true : false, true);
		assert.match(result.content[0].text, /ic: Hope/);
		assert.match(result.content[0].text, /next_step: !plannotator annotate /);
		assert.equal(result.details.ic, "Hope");
		assert.equal(result.details.nextStep, `!plannotator annotate ${planFilePath}`);
		assert.match(client.turnCalls[0]!.prompt, /Write the plan only to:/);
		assert.equal(registry.findAgent(planState.activePlan?.agentId ?? "")?.model, "gpt-5.4-mini");
		assert.equal(registry.findAgent(planState.activePlan?.agentId ?? "")?.effort, "high");
	} finally {
		process.chdir(previousCwd);
	}
});

test("plan_resume reuses the same IC, thread, and plan file with explicit feedback", { concurrency: false }, async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const registry = new DoeRegistry();
	const client = new FakePlanClient(registry, [
		"# Draft\n\nInitial plan.\n",
		"# Revised\n\nUpdated plan.\n",
	]);
	let planState = createEmptyPlanState();
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir,
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});
	const previousCwd = process.cwd();
	process.chdir(repoRoot);

	try {
		await tools.start.execute("tool-1", {
			ic: "Hope",
			planSlug: "auth refactor",
			prompt: "Plan the auth rewrite.",
		}, undefined);

		const result = await tools.resume.execute("tool-2", {
			feedback: "Add rollout and testing.",
			commentary: "Keep scope tight.",
		}, undefined);

		const planFilePath = planState.activePlan?.planFilePath ?? "";
		assert.equal(planState.activePlan?.ic, "Hope");
		assert.equal(planState.activePlan?.threadId, "thread-1");
		assert.match(planFilePath, /\/\.tmp\/feature-x\/plan-auth-refactor\.md$/);
		assert.equal(client.resumeCalls.length, 1);
		assert.equal(client.resumeCalls[0]?.model, "gpt-5.4-mini");
		assert.match(client.turnCalls[1]!.prompt, /CTO Review Feedback/);
		assert.match(client.turnCalls[1]!.prompt, /Add rollout and testing\./);
		assert.match(client.turnCalls[1]!.prompt, /Keep scope tight\./);
		assert.match(client.turnCalls[1]!.prompt, /Rewrite the plan only at:/);
		assert.match(readFileSync(planFilePath, "utf-8"), /Updated plan/);
		assert.match(result.content[0].text, /next_step: !plannotator annotate /);
		assert.equal(result.details.ic, "Hope");
		assert.equal(result.details.nextStep, `!plannotator annotate ${planFilePath}`);
	} finally {
		process.chdir(previousCwd);
	}
});

test("plan_stop interrupts the active plan and clears the single active plan state", async () => {
	const registry = new DoeRegistry();
	const seat = registry.assignSeat({ agentId: "agent-1", ic: "Hope" });
	registry.upsertAgent(
		createAgent({
			id: "agent-1",
			name: seat.name,
			threadId: "thread-1",
			activeTurnId: "turn-1",
			seatName: seat.name,
			seatRole: seat.role,
		}),
	);
	const client = new FakePlanClient(registry, []);
	let planState: DoePlanState = {
		version: 3,
		sessionSlugReminderSentAtTurn: null,
		activePlan: {
			planSlug: "auth-refactor",
			planFilePath: "/tmp/plan-auth-refactor.md",
			ic: "Hope",
			agentId: "agent-1",
			threadId: "thread-1",
		},
	};
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir: mkdtempSync(join(tmpdir(), "doe-plan-templates-")),
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});

	const result = await tools.stop.execute("tool-3", {}, undefined);

	assert.deepEqual(client.interruptCalls, [{ threadId: "thread-1", turnId: "turn-1" }]);
	assert.equal(planState.activePlan, null);
	assert.equal(registry.findAgent("agent-1")?.state, "awaiting_input");
	assert.equal(result.details.interrupted, true);
	assert.match(result.content[0].text, /Stopped planning workflow for auth-refactor\./);
});

test("plan_start retry after failed launch does not require allowExisting and does not leave an empty plan file behind", { concurrency: false }, async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const registry = new DoeRegistry();
	let planState = createEmptyPlanState();
	const failingClient = new FailingStartThreadClient(registry, []);
	const tools = await createToolHarness({
		registry,
		client: failingClient,
		templatesDir,
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});
	const previousCwd = process.cwd();
	process.chdir(repoRoot);

	try {
		await assert.rejects(
			tools.start.execute("tool-4", {
				ic: "Hope",
				planSlug: "auth refactor",
				prompt: "Plan the auth rewrite.",
			}, undefined),
			/startThread failed/,
		);

		const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
		assert.equal(planState.activePlan, null);
		assert.equal(existsSync(planFilePath), false);

		const retryClient = new FakePlanClient(registry, ["# Draft\n\nRetry plan.\n"]);
		const retryTools = await createToolHarness({
			registry,
			client: retryClient,
			templatesDir,
			getPlanState: () => planState,
			setPlanState: (updater) => {
				planState = updater(planState);
				return planState;
			},
		});
		const retry = await retryTools.start.execute("tool-5", {
			ic: "Hope",
			planSlug: "auth refactor",
			prompt: "Plan the auth rewrite.",
		}, undefined);

		assert.match(retry.content[0].text, /next_step: !plannotator annotate /);
		assert.equal(existsSync(planState.activePlan?.planFilePath ?? ""), true);
	} finally {
		process.chdir(previousCwd);
	}
});
