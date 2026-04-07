import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./test-runner.ts";
import { mockModule } from "./module-mock.ts";
import type { DoePlanReviewResult } from "../src/plan/review.ts";
import { createEmptyPlanState, type DoePlanState } from "../src/plan/session-state.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";

mockModule("@sinclair/typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: () => ({ type: "string" }),
		Optional: (value: unknown) => value,
		Boolean: () => ({ type: "boolean" }),
	},
}));

mockModule("@mariozechner/pi-tui", () => ({
	Text: class Text {
		text: string;
		x: number;
		y: number;

		constructor(text: string, x = 0, y = 0) {
			this.text = text;
			this.x = x;
			this.y = y;
		}
	},
}));

mockModule("@mariozechner/pi-coding-agent", () => ({}));

let planToolModules:
	| {
		registerPlanResumeTool: typeof import("../src/tools/plan-resume.ts").registerPlanResumeTool;
		registerPlanStartTool: typeof import("../src/tools/plan-start.ts").registerPlanStartTool;
		registerPlanStopTool: typeof import("../src/tools/plan-stop.ts").registerPlanStopTool;
	}
	| null = null;

async function loadPlanTools() {
	if (planToolModules) {return planToolModules;}
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
		seatRole: "intern",
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
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	};

	Reflect.apply(registerPlanStartTool, undefined, [pi, {
		client: input.client,
		registry: input.registry,
		templatesDir: input.templatesDir,
		reviewPlan: async ({ planFilePath, cwd }) => {
			reviewCalls.push({ planFilePath, cwd });
			const next = reviewResults.shift() ?? { status: "approved", feedback: null };
			if (next instanceof Error) {throw next;}
			return next;
		},
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	}]);
	Reflect.apply(registerPlanResumeTool, undefined, [pi, {
		client: input.client,
		registry: input.registry,
		templatesDir: input.templatesDir,
		reviewPlan: async ({ planFilePath, cwd }) => {
			reviewCalls.push({ planFilePath, cwd });
			const next = reviewResults.shift() ?? { status: "approved", feedback: null };
			if (next instanceof Error) {throw next;}
			return next;
		},
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: (updater) => input.setPlanState(updater),
	}]);
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
	assert.equal(input.planState.activePlan?.reviewFeedback, "# Plan Feedback\n\nAdd rollout guidance.");
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
	assert.equal(input.registry.findAgent(input.planState.activePlan?.agentId ?? "")?.model, "gpt-5.4-mini");
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

test(
	"plan_start requires an explicit IC, writes the plan file, and captures revision feedback automatically",
	{ concurrency: false },
	async () => {
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
			reviewResults: [{
				status: "needs_revision",
				feedback: "# Plan Feedback\n\nAdd rollout guidance.",
			}],
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
			assertPlanStartNeedsRevision({
				planState,
				registry,
				client,
				reviewCalls: tools.reviewCalls,
				result,
			});
		} finally {
			process.chdir(previousCwd);
		}
	},
);

test("plan_start approval clears the workflow and adds the closeout line", {
	concurrency: false,
}, async () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const registry = new DoeRegistry();
	const client = new FakePlanClient(registry, ["# Draft\n\nApproved plan.\n"]);
	let planState = createEmptyPlanState();
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir,
		reviewResults: [{ status: "approved", feedback: null }],
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

		assert.equal(planState.activePlan, null);
		assert.match(result.content[0].text, /review_status: approved/);
		assert.match(result.content[0].text, /Plan approved\. Workflow cleared\./);
	} finally {
		process.chdir(previousCwd);
	}
});

test("plan_resume reuses the same IC, thread, and plan file with captured review feedback", {
	concurrency: false,
}, async () => {
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
		reviewResults: [
			{ status: "needs_revision", feedback: "# Plan Feedback\n\nAdd rollout and testing." },
			{ status: "approved", feedback: null },
		],
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
				commentary: "Keep scope tight.",
			}, undefined);

			const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
			assertPlanResumeApproved({
				planState,
				client,
				planFilePath,
				reviewCalls: tools.reviewCalls,
				result,
			});
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

test(
	"plan_start retry after failed launch does not require allowExisting and does not leave an empty plan file behind",
	{ concurrency: false },
	async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-tools-"));
		const templatesDir = join(repoRoot, "templates");
		createPlanTemplate(templatesDir);
		const registry = new DoeRegistry();
		let planState = createEmptyPlanState();
		const failingClient = new FakePlanClient(registry, [], { failStartThread: true });
		const tools = await createToolHarness({
			registry,
			client: failingClient,
			templatesDir,
			reviewResults: [{ status: "approved", feedback: null }],
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
				reviewResults: [{
					status: "needs_revision",
					feedback: "# Plan Feedback\n\nRetry feedback.",
				}],
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

			assert.match(retry.content[0].text, /review_status: needs_revision/);
			assert.equal(existsSync(planState.activePlan?.planFilePath ?? ""), true);
		} finally {
			process.chdir(previousCwd);
		}
	},
);

test(
	"plan_start review failure leaves the plan ready for review and plan_resume retries the same review loop",
	{ concurrency: false },
	async () => {
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
			reviewResults: [
				new Error("Plannotator CLI review failed: browser startup failed"),
				{ status: "needs_revision", feedback: "# Plan Feedback\n\nRetry worked." },
			],
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
				tools.start.execute("tool-6", {
					ic: "Hope",
					planSlug: "auth refactor",
					prompt: "Plan the auth rewrite.",
				}, undefined),
					/retry review for the same plan workflow/,
				);

			assert.equal(planState.activePlan?.status, "ready_for_review");
			assert.equal(planState.activePlan?.reviewFeedback, null);
			assert.equal(client.turnCalls.length, 1);

			const result = await tools.resume.execute("tool-7", {}, undefined);

			assert.equal(client.turnCalls.length, 1);
			assert.equal(tools.reviewCalls.length, 2);
			assert.equal(planState.activePlan?.status, "needs_revision");
			assert.equal(planState.activePlan?.reviewFeedback, "# Plan Feedback\n\nRetry worked.");
			assert.match(result.content[0].text, /Review retried without revising the plan\./);
			assert.match(result.content[0].text, /review_status: needs_revision/);
			assert.match(result.content[0].text, /<review_feedback>/);
			assert.match(result.content[0].text, /<next_step>/);
		} finally {
			process.chdir(previousCwd);
		}
	},
);

test("plan_resume review failure after a revision stays retryable without another rewrite", {
	concurrency: false,
}, async () => {
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
		reviewResults: [
			{ status: "needs_revision", feedback: "# Plan Feedback\n\nAdd rollout and testing." },
			new Error("Plannotator review was cancelled before a decision was captured."),
			{ status: "approved", feedback: null },
		],
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});
	const previousCwd = process.cwd();
	process.chdir(repoRoot);

	try {
		await tools.start.execute("tool-8", {
			ic: "Hope",
			planSlug: "auth refactor",
			prompt: "Plan the auth rewrite.",
		}, undefined);

		await assert.rejects(
			tools.resume.execute("tool-9", {
				commentary: "Keep scope tight.",
			}, undefined),
			/retry review for the same plan workflow/,
		);

		assert.equal(planState.activePlan?.status, "ready_for_review");
		assert.equal(planState.activePlan?.reviewFeedback, null);
		assert.equal(client.turnCalls.length, 2);

		const retry = await tools.resume.execute("tool-10", {}, undefined);

		assert.equal(client.turnCalls.length, 2);
		assert.equal(planState.activePlan, null);
		assert.match(retry.content[0].text, /Review retried without revising the plan\./);
		assert.match(retry.content[0].text, /review_status: approved/);
		assert.match(retry.content[0].text, /Plan approved\. Workflow cleared\./);
	} finally {
		process.chdir(previousCwd);
	}
});
