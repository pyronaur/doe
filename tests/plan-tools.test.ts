import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoePlanReviewResult } from "../src/plan/review.ts";
import { createEmptyPlanState, type DoePlanState } from "../src/plan/session-state.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";
import { attachSeatAgent, createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";
import { mockToolModules } from "./tool-module-mocks.ts";

mockToolModules();

let planToolModules:
	| {
		registerPlanResumeTool: typeof import("../src/tools/plan-resume.ts").registerPlanResumeTool;
		registerPlanStartTool: typeof import("../src/tools/plan-start.ts").registerPlanStartTool;
		registerPlanStopTool: typeof import("../src/tools/plan-stop.ts").registerPlanStopTool;
	}
	| null = null;

async function loadPlanTools() {
	if (planToolModules) { return planToolModules; }
	const [{ registerPlanResumeTool }, { registerPlanStartTool }, { registerPlanStopTool }] =
		await Promise.all([
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
	return createRegistryAgent({
		name: "Hope",
		effort: "medium",
		template: "plan",
		allowWrite: true,
		threadId: "thread-1",
		activeTurnId: "turn-1",
		activityLabel: "thinking",
		usage: null,
		compaction: null,
		runStartedAt: 1,
		completionNotified: false,
		recovered: false,
		seatName: "Hope",
		seatRole: "intern",
		finishNote: null,
		reuseSummary: null,
		...overrides,
	});
}

function extractPlanFilePath(prompt: string): string {
	const match = prompt.match(/(?:Write the plan only to|Rewrite the plan only at):\s*(.+)$/m);
	assert.ok(match?.[1], `missing plan file path in prompt:\n${prompt}`);
	return match[1].trim();
}

class FakePlanClient {
	threadCalls: Array<Record<string, unknown>> = [];
	turnCalls: Array<{ threadId: string; prompt: string }> = [];
	resumeCalls: Array<Record<string, unknown>> = [];
	interruptCalls: Array<{ threadId: string; turnId: string }> = [];
	steerCalls: Array<{ threadId: string; expectedTurnId: string; prompt: string }> = [];
	private nextThread = 0;
	private nextTurn = 0;
	private readonly registry: DoeRegistry;
	private readonly planBodies: string[];
	private readonly failStartThread: boolean;

	constructor(
		registry: DoeRegistry,
		planBodies: string[],
		options: { failStartThread?: boolean } = {},
	) {
		this.registry = registry;
		this.planBodies = planBodies;
		this.failStartThread = options.failStartThread ?? false;
	}

	async startThread(options: Record<string, unknown>) {
		if (this.failStartThread) {
			throw new Error("startThread failed");
		}
		this.threadCalls.push(options);
		this.nextThread += 1;
		return { thread: { id: `thread-${this.nextThread}` } };
	}

	async startTurn(input: { threadId: string; prompt: string }) {
		this.turnCalls.push(input);
		this.nextTurn += 1;
		const turnId = `turn-${this.nextTurn}`;
		writeFileSync(extractPlanFilePath(input.prompt), this.planBodies.shift() ?? "# Draft\n",
			"utf-8");
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
		writeFileSync(extractPlanFilePath(input.prompt), this.planBodies.shift() ?? "# Revised\n",
			"utf-8");
		setTimeout(() => {
			this.registry.markCompleted(input.threadId, input.expectedTurnId,
				`Completed ${input.expectedTurnId}`);
		}, 0);
	}

	async interruptTurn(threadId: string, turnId: string) {
		this.interruptCalls.push({ threadId, turnId });
	}
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`Missing tool "${name}".`);
	}
	return tool;
}

async function createToolHarness(input: {
	registry: DoeRegistry;
	client: FakePlanClient;
	templatesDir: string;
	reviewResults?: Array<DoePlanReviewResult | Error>;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState) => DoePlanState;
}) {
	const { registerPlanResumeTool, registerPlanStartTool, registerPlanStopTool } =
		await loadPlanTools();
	const tools = new Map<string, RegisteredTool>();
	const reviewCalls: Array<{ planFilePath: string; cwd: string }> = [];
	const reviewResults = [...(input.reviewResults ?? [{ status: "approved", feedback: null }])];
	const reviewPlan = async ({ planFilePath, cwd }: { planFilePath: string; cwd: string }) => {
		reviewCalls.push({ planFilePath, cwd });
		const next = reviewResults.shift() ?? { status: "approved", feedback: null };
		if (next instanceof Error) { throw next; }
		return next;
	};
	const planDeps = {
		client: input.client,
		registry: input.registry,
		templatesDir: input.templatesDir,
		reviewPlan,
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: (updater: (state: DoePlanState) => DoePlanState) => input.setPlanState(updater),
	};
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	};

	Reflect.apply(registerPlanStartTool, undefined, [pi, planDeps]);
	Reflect.apply(registerPlanResumeTool, undefined, [pi, planDeps]);
	Reflect.apply(registerPlanStopTool, undefined, [pi, {
		client: input.client,
		registry: input.registry,
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	}]);

	return {
		start: getTool(tools, "plan_start"),
		resume: getTool(tools, "plan_resume"),
		stop: getTool(tools, "plan_stop"),
		reviewCalls,
	};
}

function assertPlanStartNeedsRevision(input: {
	planState: DoePlanState;
	registry: DoeRegistry;
	client: FakePlanClient;
	reviewCalls: Array<{ planFilePath: string; cwd: string }>;
	result: any;
}) {
	const planFilePath = input.planState.activePlan?.planFilePath ?? "";
	assert.equal(input.planState.activePlan?.sessionSlug, "feature-x");
	assert.equal(input.planState.activePlan?.ic, "Hope");
	assert.match(planFilePath, /\/\.tmp\/feature-x\/plan-auth-refactor\.md$/);
	assert.equal(input.planState.activePlan?.threadId, "thread-1");
	assert.equal(input.planState.activePlan?.status, "needs_revision");
	assert.equal(input.planState.activePlan?.reviewFeedback,
		"# Plan Feedback\n\nAdd rollout guidance.");
	assert.ok(existsSync(planFilePath));
	assert.match(readFileSync(planFilePath, "utf-8"), /Initial plan/);
	assert.equal(input.client.threadCalls[0]?.model, "gpt-5.4-mini");
	assert.ok(input.client.turnCalls[0]);
	assert.equal(input.reviewCalls.length, 1);
	assert.equal(input.reviewCalls[0]?.planFilePath, planFilePath);
	assert.match(input.result.content[0].text, /ic: Hope/);
	assert.match(input.result.content[0].text, /review_status: needs_revision/);
	assert.match(input.result.content[0].text, /Add rollout guidance/);
	assert.equal(input.result.details.ic, "Hope");
	assert.equal(input.result.details.reviewStatus, "needs_revision");
	assert.equal(input.result.details.reviewFeedback, "# Plan Feedback\n\nAdd rollout guidance.");
	assert.match(input.client.turnCalls[0].prompt, /Write the plan only to:/);
	assert.equal(input.registry.findAgent(input.planState.activePlan?.agentId ?? "")?.model,
		"gpt-5.4-mini");
	assert.equal(input.registry.findAgent(input.planState.activePlan?.agentId ?? "")?.effort, "high");
}

function assertPlanResumeApproved(input: {
	planState: DoePlanState;
	client: FakePlanClient;
	planFilePath: string;
	reviewCalls: Array<{ planFilePath: string; cwd: string }>;
	result: any;
}) {
	assert.equal(input.planState.activePlan, null);
	assert.match(input.planFilePath, /\/\.tmp\/feature-x\/plan-auth-refactor\.md$/);
	assert.equal(input.client.resumeCalls.length, 1);
	assert.equal(input.client.resumeCalls[0]?.model, "gpt-5.4-mini");
	assert.match(input.client.turnCalls[1].prompt, /<review_feedback>/);
	assert.match(input.client.turnCalls[1].prompt, /<additional_instructions>/);
	assert.match(input.client.turnCalls[1].prompt, /Add rollout and testing\./);
	assert.match(input.client.turnCalls[1].prompt, /Keep scope tight\./);
	assert.match(input.client.turnCalls[1].prompt, /Rewrite the plan only at:/);
	assert.match(readFileSync(input.planFilePath, "utf-8"), /Updated plan/);
	assert.equal(input.reviewCalls.length, 2);
	assert.match(input.result.content[0].text, /review_status: approved/);
	assert.match(input.result.content[0].text, /Plan approved\. Workflow cleared\./);
	assert.equal(input.result.details.ic, "Hope");
	assert.equal(input.result.details.reviewStatus, "approved");
	assert.equal(input.result.details.reviewFeedback, null);
}

interface PlanStateHandle {
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState) => DoePlanState;
	read: () => DoePlanState;
}

function createPlanStateHandle(initial: DoePlanState = createEmptyPlanState()): PlanStateHandle {
	let planState = initial;
	return {
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
		read: () => planState,
	};
}

const PLAN_START_INPUT = {
	ic: "Hope",
	planSlug: "auth refactor",
	prompt: "Plan the auth rewrite.",
};

async function runPlanStart(
	tool: RegisteredTool,
	toolCallId: string,
	overrides: Record<string, unknown> = {},
) {
	return await tool.execute(toolCallId, { ...PLAN_START_INPUT, ...overrides }, undefined);
}

async function runPlanResume(
	tool: RegisteredTool,
	toolCallId: string,
	input: Record<string, unknown> = {},
) {
	return await tool.execute(toolCallId, input, undefined);
}

async function withPlanRepo(
	run: (input: { repoRoot: string; templatesDir: string }) => Promise<void>,
) {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const previousCwd = process.cwd();
	process.chdir(repoRoot);
	try {
		await run({ repoRoot, templatesDir });
	} finally {
		process.chdir(previousCwd);
	}
}

async function createPlanHarness(input: {
	templatesDir: string;
	planBodies: string[];
	reviewResults?: Array<DoePlanReviewResult | Error>;
	failStartThread?: boolean;
	planState?: DoePlanState;
}) {
	const registry = new DoeRegistry();
	const client = new FakePlanClient(registry, input.planBodies, {
		failStartThread: input.failStartThread,
	});
	const planState = createPlanStateHandle(input.planState);
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir: input.templatesDir,
		reviewResults: input.reviewResults,
		getPlanState: planState.getPlanState,
		setPlanState: planState.setPlanState,
	});
	return {
		...tools,
		client,
		planState,
		registry,
	};
}

test(
	"plan_start requires an explicit IC, writes the plan file, and captures revision feedback automatically",
	{ concurrency: false },
	async () => {
		await withPlanRepo(async ({ templatesDir }) => {
			const harness = await createPlanHarness({
				templatesDir,
				planBodies: ["# Draft\n\nInitial plan.\n"],
				reviewResults: [{
					status: "needs_revision",
					feedback: "# Plan Feedback\n\nAdd rollout guidance.",
				}],
			});
			const result = await runPlanStart(harness.start, "tool-1");
			assertPlanStartNeedsRevision({
				planState: harness.planState.read(),
				registry: harness.registry,
				client: harness.client,
				reviewCalls: harness.reviewCalls,
				result,
			});
		});
	},
);

test("plan_start approval clears the workflow and adds the closeout line", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: ["# Draft\n\nApproved plan.\n"],
			reviewResults: [{ status: "approved", feedback: null }],
		});
		const result = await runPlanStart(harness.start, "tool-1");
		assert.equal(harness.planState.read().activePlan, null);
		assert.match(result.content[0].text, /review_status: approved/);
		assert.match(result.content[0].text, /Plan approved\. Workflow cleared\./);
	});
});

test("plan_resume reuses the same IC, thread, and plan file with captured review feedback", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ repoRoot, templatesDir }) => {
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: [
				"# Draft\n\nInitial plan.\n",
				"# Revised\n\nUpdated plan.\n",
			],
			reviewResults: [
				{ status: "needs_revision", feedback: "# Plan Feedback\n\nAdd rollout and testing." },
				{ status: "approved", feedback: null },
			],
		});
		await runPlanStart(harness.start, "tool-1");
		const result = await runPlanResume(harness.resume, "tool-2", {
			commentary: "Keep scope tight.",
		});
		assertPlanResumeApproved({
			planState: harness.planState.read(),
			client: harness.client,
			planFilePath: join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md"),
			reviewCalls: harness.reviewCalls,
			result,
		});
	});
});

test("plan_stop interrupts the active plan and clears the single active plan state", async () => {
	const registry = new DoeRegistry();
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: createAgent({
			id: "agent-1",
			activeTurnId: "turn-1",
		}),
	});
	const client = new FakePlanClient(registry, []);
	const planState = createPlanStateHandle({
		version: 4,
		sessionSlugReminderSentAtTurn: null,
		activePlan: {
			sessionSlug: "feature-x",
			planSlug: "auth-refactor",
			planFilePath: "/tmp/plan-auth-refactor.md",
			ic: "Hope",
			agentId: "agent-1",
			threadId: "thread-1",
			status: "needs_revision",
			reviewFeedback: "Tighten scope.",
		},
	});
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir: mkdtempSync(join(tmpdir(), "doe-plan-templates-")),
		getPlanState: planState.getPlanState,
		setPlanState: planState.setPlanState,
	});

	const result = await tools.stop.execute("tool-3", {}, undefined);

	assert.deepEqual(client.interruptCalls, [{ threadId: "thread-1", turnId: "turn-1" }]);
	assert.equal(planState.read().activePlan, null);
	assert.equal(registry.findAgent("agent-1")?.state, "awaiting_input");
	assert.equal(result.details.interrupted, true);
	assert.match(result.content[0].text, /Stopped planning workflow for auth-refactor\./);
});

test(
	"plan_start retry after failed launch does not require allowExisting and does not leave an empty plan file behind",
	{ concurrency: false },
	async () => {
		await withPlanRepo(async ({ repoRoot, templatesDir }) => {
			const harness = await createPlanHarness({
				templatesDir,
				planBodies: [],
				reviewResults: [{ status: "approved", feedback: null }],
				failStartThread: true,
			});
			await assert.rejects(
				runPlanStart(harness.start, "tool-4"),
				/startThread failed/,
			);

			const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
			assert.equal(harness.planState.read().activePlan, null);
			assert.equal(existsSync(planFilePath), false);

			const retryClient = new FakePlanClient(harness.registry, ["# Draft\n\nRetry plan.\n"]);
			const retryTools = await createToolHarness({
				registry: harness.registry,
				client: retryClient,
				templatesDir,
				reviewResults: [{
					status: "needs_revision",
					feedback: "# Plan Feedback\n\nRetry feedback.",
				}],
				getPlanState: harness.planState.getPlanState,
				setPlanState: harness.planState.setPlanState,
			});
			const retry = await runPlanStart(retryTools.start, "tool-5");

			assert.match(retry.content[0].text, /review_status: needs_revision/);
			assert.equal(existsSync(harness.planState.read().activePlan?.planFilePath ?? ""), true);
		});
	},
);

test(
	"plan_start review failure leaves the plan ready for review and plan_resume retries the same review loop",
	{ concurrency: false },
	async () => {
		await withPlanRepo(async ({ templatesDir }) => {
			const harness = await createPlanHarness({
				templatesDir,
				planBodies: ["# Draft\n\nInitial plan.\n"],
				reviewResults: [
					new Error("Plannotator CLI review failed: browser startup failed"),
					{ status: "needs_revision", feedback: "# Plan Feedback\n\nRetry worked." },
				],
			});
			await assert.rejects(
				runPlanStart(harness.start, "tool-6"),
				/retry review for the same plan workflow/,
			);

			assert.equal(harness.planState.read().activePlan?.status, "ready_for_review");
			assert.equal(harness.planState.read().activePlan?.reviewFeedback, null);
			assert.equal(harness.client.turnCalls.length, 1);

			const result = await runPlanResume(harness.resume, "tool-7");

			assert.equal(harness.client.turnCalls.length, 1);
			assert.equal(harness.reviewCalls.length, 2);
			assert.equal(harness.planState.read().activePlan?.status, "needs_revision");
			assert.equal(harness.planState.read().activePlan?.reviewFeedback,
				"# Plan Feedback\n\nRetry worked.");
			assert.match(result.content[0].text, /Review retried without revising the plan\./);
			assert.match(result.content[0].text, /review_status: needs_revision/);
			assert.match(result.content[0].text, /<review_feedback>/);
			assert.match(result.content[0].text, /<next_step>/);
		});
	},
);

test("plan_resume review failure after a revision stays retryable without another rewrite", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: [
				"# Draft\n\nInitial plan.\n",
				"# Revised\n\nUpdated plan.\n",
			],
			reviewResults: [
				{ status: "needs_revision", feedback: "# Plan Feedback\n\nAdd rollout and testing." },
				new Error("Plannotator review was cancelled before a decision was captured."),
				{ status: "approved", feedback: null },
			],
		});
		await runPlanStart(harness.start, "tool-8");

		await assert.rejects(
			runPlanResume(harness.resume, "tool-9", {
				commentary: "Keep scope tight.",
			}),
			/retry review for the same plan workflow/,
		);

		assert.equal(harness.planState.read().activePlan?.status, "ready_for_review");
		assert.equal(harness.planState.read().activePlan?.reviewFeedback, null);
		assert.equal(harness.client.turnCalls.length, 2);

		const retry = await runPlanResume(harness.resume, "tool-10");

		assert.equal(harness.client.turnCalls.length, 2);
		assert.equal(harness.planState.read().activePlan, null);
		assert.match(retry.content[0].text, /Review retried without revising the plan\./);
		assert.match(retry.content[0].text, /review_status: approved/);
		assert.match(retry.content[0].text, /Plan approved\. Workflow cleared\./);
	});
});
