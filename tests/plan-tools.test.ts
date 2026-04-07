import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DoePlanReviewResult } from "../src/plan/review.ts";
import { startPlanReviewCli } from "../src/plan/review.ts";
import {
	clonePlanState,
	createEmptyPlanState,
	type DoePlanState,
} from "../src/plan/session-state.ts";
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
	if (planToolModules) {
		return planToolModules;
	}
	const [{ registerPlanResumeTool }, { registerPlanStartTool }, { registerPlanStopTool }] =
		await Promise.all([
			import("../src/tools/plan-resume.ts"),
			import("../src/tools/plan-start.ts"),
			import("../src/tools/plan-stop.ts"),
		]);
	planToolModules = { registerPlanResumeTool, registerPlanStartTool, registerPlanStopTool };
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

function extractPlanFilePath(prompt: string): string {
	const match = prompt.match(/(?:Write the plan only to|Rewrite the plan only at):\s*(.+)$/m);
	assert.ok(match?.[1], `missing plan file path in prompt:\n${prompt}`);
	return match[1].trim();
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
		seatRole: "researcher",
		finishNote: null,
		reuseSummary: null,
		...overrides,
	});
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

	constructor(registry: DoeRegistry, planBodies: string[]) {
		this.registry = registry;
		this.planBodies = planBodies;
	}

	async startThread(options: Record<string, unknown>) {
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
		writeFileSync(
			extractPlanFilePath(input.prompt),
			this.planBodies.shift() ?? "# Revised\n",
			"utf-8",
		);
		setTimeout(() => {
			this.registry.markCompleted(
				input.threadId,
				input.expectedTurnId,
				`Completed ${input.expectedTurnId}`,
			);
		}, 0);
	}

	async interruptTurn(threadId: string, turnId: string) {
		this.interruptCalls.push({ threadId, turnId });
	}
}

interface DeferredReview {
	reviewId: string;
	wait: Promise<DoePlanReviewResult>;
	resolve: (value: DoePlanReviewResult) => void;
	reject: (error: Error) => void;
}

interface ReviewController {
	calls: Array<{ reviewId: string; planFilePath: string; cwd: string }>;
	startReviewPlan: (
		input: { reviewId?: string; planFilePath: string; cwd: string },
	) => {
		reviewId: string;
		wait: Promise<DoePlanReviewResult>;
		started?: Promise<void>;
		isAlive?: () => boolean;
	};
	resolve: (reviewId: string, value: DoePlanReviewResult) => void;
	reject: (reviewId: string, error: Error) => void;
}

function createReviewController(): ReviewController {
	const calls: Array<{ reviewId: string; planFilePath: string; cwd: string }> = [];
	const jobs = new Map<string, DeferredReview>();
	let nextReview = 0;

	const startReviewPlan = (input: { reviewId?: string; planFilePath: string; cwd: string }) => {
		const reviewId = input.reviewId ?? `review-${++nextReview}`;
		calls.push({ reviewId, planFilePath: input.planFilePath, cwd: input.cwd });
		const existing = jobs.get(reviewId);
		if (existing) {
			return {
				reviewId,
				wait: existing.wait,
				started: Promise.resolve(),
				isAlive: () => jobs.has(reviewId),
			};
		}
		let resolve!: (value: DoePlanReviewResult) => void;
		let reject!: (error: Error) => void;
		const wait = new Promise<DoePlanReviewResult>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		jobs.set(reviewId, { reviewId, wait, resolve, reject });
		return {
			reviewId,
			wait,
			started: Promise.resolve(),
			isAlive: () => jobs.has(reviewId),
		};
	};

	const resolve = (reviewId: string, value: DoePlanReviewResult) => {
		const job = jobs.get(reviewId);
		if (!job) {
			throw new Error(`Unknown review ${reviewId}`);
		}
		job.resolve(value);
		jobs.delete(reviewId);
	};

	const reject = (reviewId: string, error: Error) => {
		const job = jobs.get(reviewId);
		if (!job) {
			throw new Error(`Unknown review ${reviewId}`);
		}
		job.reject(error);
		jobs.delete(reviewId);
	};

	return { calls, startReviewPlan, resolve, reject };
}

function createImmediateFailReviewController(message: string): ReviewController {
	const calls: Array<{ reviewId: string; planFilePath: string; cwd: string }> = [];
	let nextReview = 0;
	return {
		calls,
		startReviewPlan(input: { reviewId?: string; planFilePath: string; cwd: string }) {
			const reviewId = input.reviewId ?? `review-${++nextReview}`;
			calls.push({ reviewId, planFilePath: input.planFilePath, cwd: input.cwd });
			const failed = Promise.reject(new Error(message));
			void failed.catch(() => {});
			return {
				reviewId,
				started: failed,
				wait: failed,
				isAlive: () => false,
			};
		},
		resolve(reviewId: string) {
			throw new Error(`Unexpected resolve for ${reviewId}`);
		},
		reject(reviewId: string) {
			throw new Error(`Unexpected reject for ${reviewId}`);
		},
	};
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<any>;
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`Missing tool "${name}".`);
	}
	return tool;
}

interface PlanStateHandle {
	getPlanState: () => DoePlanState;
	setPlanState: (
		updater: (state: DoePlanState) => DoePlanState,
		_options?: { flush?: boolean },
	) => DoePlanState;
	read: () => DoePlanState;
	history: () => DoePlanState[];
}

function createPlanStateHandle(initial: DoePlanState = createEmptyPlanState()): PlanStateHandle {
	let planState = initial;
	const updates: DoePlanState[] = [clonePlanState(initial)];
	return {
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			updates.push(clonePlanState(planState));
			return planState;
		},
		read: () => planState,
		history: () => updates.map((entry) => clonePlanState(entry)),
	};
}

async function createToolHarness(input: {
	registry: DoeRegistry;
	client: FakePlanClient;
	templatesDir: string;
	reviewController: ReviewController;
	getPlanState: () => DoePlanState;
	setPlanState: (
		updater: (state: DoePlanState) => DoePlanState,
		options?: { flush?: boolean },
	) => DoePlanState;
}) {
	const { registerPlanResumeTool, registerPlanStartTool, registerPlanStopTool } =
		await loadPlanTools();
	const tools = new Map<string, RegisteredTool>();
	const planDeps = {
		client: input.client,
		registry: input.registry,
		templatesDir: input.templatesDir,
		startReviewPlan: input.reviewController.startReviewPlan,
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: input.setPlanState,
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
		setPlanState: input.setPlanState,
	}]);

	return {
		start: getTool(tools, "plan_start"),
		resume: getTool(tools, "plan_resume"),
		stop: getTool(tools, "plan_stop"),
	};
}

const PLAN_START_INPUT = {
	ic: "Hope",
	planSlug: "auth refactor",
	prompt: "Plan the auth rewrite.",
};

async function runPlanStart(tool: RegisteredTool) {
	return await tool.execute("tool-start", PLAN_START_INPUT, undefined);
}

async function runPlanResume(tool: RegisteredTool, input: Record<string, unknown> = {}) {
	return await tool.execute("tool-resume", input, undefined);
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
	planState?: DoePlanState;
	reviewController?: ReviewController;
}) {
	const registry = new DoeRegistry();
	const client = new FakePlanClient(registry, input.planBodies);
	const reviewController = input.reviewController ?? createReviewController();
	const planState = createPlanStateHandle(input.planState);
	const tools = await createToolHarness({
		registry,
		client,
		templatesDir: input.templatesDir,
		reviewController,
		getPlanState: planState.getPlanState,
		setPlanState: planState.setPlanState,
	});
	return {
		...tools,
		client,
		planState,
		registry,
		reviewController,
	};
}

function setPathPrefix(prefix: string) {
	const originalPath = process.env.PATH;
	process.env.PATH = `${prefix}:${originalPath ?? ""}`;
	return () => {
		if (originalPath === undefined) {
			delete process.env.PATH;
			return;
		}
		process.env.PATH = originalPath;
	};
}

function createBlockingPlannotator() {
	const fakeBinDir = mkdtempSync(join(tmpdir(), "doe-plan-review-stop-"));
	const fakeCliPath = join(fakeBinDir, "plannotator");
	writeFileSync(
		fakeCliPath,
		[
			"#!/bin/sh",
			"cat >/dev/null",
			"while true; do",
			"  sleep 1",
			"done",
		].join("\n"),
		"utf-8",
	);
	chmodSync(fakeCliPath, 0o755);
	return fakeBinDir;
}

function createStopPlanState(planFilePath: string) {
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
		version: 5,
		sessionSlugReminderSentAtTurn: null,
		activePlan: {
			sessionSlug: "feature-x",
			planSlug: "auth-refactor",
			planFilePath,
			ic: "Hope",
			agentId: "agent-1",
			threadId: "thread-1",
			status: "ready_for_review",
			reviewFeedback: null,
		},
		pendingReview: {
			reviewId: "review-stop-1",
			sessionSlug: "feature-x",
			planSlug: "auth-refactor",
			planFilePath,
			agentId: "agent-1",
			requestedAt: Date.now(),
		},
	});
	return { registry, client, planState };
}

function writePlanDraft(planFilePath: string, body = "# Draft\n\nInitial plan.\n") {
	mkdirSync(dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, body, "utf-8");
}

function attachCompletedPlanAgent(registry: DoeRegistry) {
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: createAgent({
			id: "agent-1",
			threadId: "thread-1",
			state: "completed",
			activeTurnId: null,
			completedAt: Date.now(),
		}),
	});
}

function attachWorkingPlanAgent(registry: DoeRegistry, turnId = "turn-active") {
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: createAgent({
			id: "agent-1",
			threadId: "thread-1",
			state: "working",
			activeTurnId: turnId,
		}),
	});
}

function createNeedsRevisionPlanState(
	planFilePath: string,
	reviewFeedback = DEFAULT_REVIEW_FEEDBACK,
): DoePlanState {
	return {
		version: 5,
		sessionSlugReminderSentAtTurn: null,
		activePlan: {
			sessionSlug: "feature-x",
			planSlug: "auth-refactor",
			planFilePath,
			ic: "Hope",
			agentId: "agent-1",
			threadId: "thread-1",
			status: "needs_revision",
			reviewFeedback,
		},
		pendingReview: null,
	};
}

const DEFAULT_REVIEW_FEEDBACK = "# Plan Feedback\n\nAdd rollout and testing.";

async function createNeedsRevisionHarness(input: {
	templatesDir: string;
	attachAgent: (registry: DoeRegistry) => void;
}) {
	const planFilePath = join(process.cwd(), ".tmp", "feature-x", "plan-auth-refactor.md");
	writePlanDraft(planFilePath);
	const harness = await createPlanHarness({
		templatesDir: input.templatesDir,
		planBodies: ["# Revised\n\nUpdated plan.\n"],
		planState: createNeedsRevisionPlanState(planFilePath),
	});
	input.attachAgent(harness.registry);
	return harness;
}

function assertRevisionDraftingState(
	harness: Awaited<ReturnType<typeof createPlanHarness>>,
	reviewFeedback = DEFAULT_REVIEW_FEEDBACK,
) {
	assert.equal(harness.planState.read().activePlan?.status, "drafting");
	assert.equal(harness.planState.read().activePlan?.reviewFeedback, reviewFeedback);
	assert.equal(harness.planState.read().pendingReview, null);
	assert.equal(harness.reviewController.calls.length, 0);
}

test("plan_start returns immediately in drafting state without starting review", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: ["# Draft\n\nInitial plan.\n"],
		});

		const result = await runPlanStart(harness.start);
		const state = harness.planState.read();

		assert.match(result.content[0].text, /state: drafting/);
		assert.equal(result.details.reviewStatus, null);
		assert.equal(result.details.reviewId, null);
		assert.equal(state.activePlan?.status, "drafting");
		assert.equal(state.activePlan?.reviewFeedback, null);
		assert.equal(state.pendingReview, null);
		assert.equal(harness.reviewController.calls.length, 0);
		assert.ok(existsSync(state.activePlan?.planFilePath ?? ""));
		assert.match(readFileSync(state.activePlan?.planFilePath ?? "", "utf-8"), /Initial plan/);
	});
});

test("plan_resume after needs_revision returns immediately with drafting state", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createNeedsRevisionHarness({
			templatesDir,
			attachAgent: attachCompletedPlanAgent,
		});

		const result = await runPlanResume(harness.resume, { commentary: "Keep scope tight." });

		assert.equal(harness.client.resumeCalls.length, 1);
		assert.equal(harness.client.turnCalls.length, 1);
		assert.match(harness.client.turnCalls[0].prompt, /<review_feedback>/);
		assert.match(harness.client.turnCalls[0].prompt, /Keep scope tight\./);
		assert.match(result.content[0].text, /state: drafting/);
		assert.match(result.content[0].text, /action: turn_started/);
		assert.match(
			result.content[0].text,
			/Revision turn started and is running in the background\. Review will run automatically after the draft completes\./,
		);
		assertRevisionDraftingState(harness);
	});
});

test("plan_resume revision queues steer on an active turn and returns drafting state", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createNeedsRevisionHarness({
			templatesDir,
			attachAgent: attachWorkingPlanAgent,
		});

		const result = await runPlanResume(harness.resume, { commentary: "Keep scope tight." });

		assert.equal(harness.client.steerCalls.length, 1);
		assert.equal(harness.client.resumeCalls.length, 0);
		assert.equal(harness.client.turnCalls.length, 0);
		assert.match(result.content[0].text, /state: drafting/);
		assert.match(result.content[0].text, /action: steer_queued/);
		assertRevisionDraftingState(harness);
	});
});

test("plan_resume with persisted pending review reuses the same review id", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const planFilePath = join(process.cwd(), ".tmp", "feature-x", "plan-auth-refactor.md");
		writePlanDraft(planFilePath);
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: ["# Draft\n\nInitial plan.\n"],
			planState: {
				version: 5,
				sessionSlugReminderSentAtTurn: null,
				activePlan: {
					sessionSlug: "feature-x",
					planSlug: "auth-refactor",
					planFilePath,
					ic: "Hope",
					agentId: "agent-1",
					threadId: "thread-1",
					status: "ready_for_review",
					reviewFeedback: null,
				},
				pendingReview: {
					reviewId: "review-1",
					sessionSlug: "feature-x",
					planSlug: "auth-refactor",
					planFilePath,
					agentId: "agent-1",
					requestedAt: Date.now(),
				},
			},
		});
		attachCompletedPlanAgent(harness.registry);

		const result = await runPlanResume(harness.resume);
		assert.equal(harness.reviewController.calls.length, 1);
		assert.equal(harness.reviewController.calls[0]?.reviewId, "review-1");
		assert.match(result.content[0].text, /review_id: review-1/);
		assert.match(result.content[0].text, /Review was restored and is pending\./);
	});
});

test("plan_stop clears pendingReview and cancels an in-memory plannotator job", async () => {
	await withPlanRepo(async ({ repoRoot, templatesDir }) => {
		const fakeBinDir = createBlockingPlannotator();
		const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
		mkdirSync(join(repoRoot, ".tmp", "feature-x"), { recursive: true });
		writeFileSync(planFilePath, "# Draft\n\nInitial plan.\n", "utf-8");
		const restorePath = setPathPrefix(fakeBinDir);

		const reviewJob = startPlanReviewCli({
			reviewId: "review-stop-1",
			planFilePath,
			cwd: repoRoot,
		});
		await reviewJob.started;
		const { registry, client, planState } = createStopPlanState(planFilePath);
		const tools = await createToolHarness({
			registry,
			client,
			templatesDir,
			reviewController: createReviewController(),
			getPlanState: planState.getPlanState,
			setPlanState: planState.setPlanState,
		});

		const stopResult = await tools.stop.execute("tool-stop", {}, undefined);
		await assert.rejects(reviewJob.wait, /cancelled before a decision was captured/);
		assert.equal(planState.read().activePlan, null);
		assert.equal(planState.read().pendingReview, null);
		assert.equal(stopResult.details.cancelledReview, true);
		restorePath();
	});
});

test("plan_resume retry throws when review fails immediately after launch", {
	concurrency: false,
}, async () => {
	await withPlanRepo(async ({ templatesDir }) => {
		const harness = await createPlanHarness({
			templatesDir,
			planBodies: ["# Draft\n\nInitial plan.\n"],
			planState: {
				version: 5,
				sessionSlugReminderSentAtTurn: null,
				activePlan: {
					sessionSlug: "feature-x",
					planSlug: "auth-refactor",
					planFilePath: join(
						process.cwd(),
						".tmp",
						"feature-x",
						"plan-auth-refactor.md",
					),
					ic: "Hope",
					agentId: "agent-1",
					threadId: "thread-1",
					status: "ready_for_review",
					reviewFeedback: null,
				},
				pendingReview: null,
			},
			reviewController: createImmediateFailReviewController(
				"Failed to start Plannotator CLI: spawn plannotator ENOENT",
			),
		});
		attachSeatAgent(harness.registry, {
			agentId: "agent-1",
			ic: "Hope",
			threadId: "thread-1",
			agent: createAgent({
				id: "agent-1",
				threadId: "thread-1",
				state: "completed",
				completedAt: Date.now(),
				activeTurnId: null,
			}),
		});

		await assert.rejects(
			runPlanResume(harness.resume),
			/Failed to start Plannotator CLI: spawn plannotator ENOENT/,
		);
		assert.equal(harness.planState.read().pendingReview, null);
		assert.equal(harness.planState.read().activePlan?.status, "ready_for_review");
	});
});
