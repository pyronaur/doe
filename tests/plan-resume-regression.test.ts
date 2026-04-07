import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DoePlanState } from "../src/plan/session-state.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import { attachSeatAgent, createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";
import { mockToolModules } from "./tool-module-mocks.ts";

mockToolModules();

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

class FailingPlanClient {
	resumeCalls: Array<Record<string, unknown>> = [];
	turnCalls: Array<{ threadId: string; prompt: string }> = [];

	async resumeThread(options: Record<string, unknown>) {
		this.resumeCalls.push(options);
	}

	async startTurn(input: { threadId: string; prompt: string }) {
		this.turnCalls.push(input);
		throw new Error("failed to start revision turn");
	}

	async steerTurn() {}
}

let planResumeModule:
	| {
		registerPlanResumeTool: typeof import("../src/tools/plan-resume.ts").registerPlanResumeTool;
	}
	| null = null;

async function loadPlanResumeTool() {
	if (!planResumeModule) {
		const { registerPlanResumeTool } = await import("../src/tools/plan-resume.ts");
		planResumeModule = { registerPlanResumeTool };
	}
	return planResumeModule.registerPlanResumeTool;
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
			"Rewrite the plan only at: {{planFilePath}}",
			"",
			"Task:",
			"{{task}}",
			"",
		].join("\n"),
		"utf-8",
	);
}

function createNeedsRevisionState(planFilePath: string, feedback: string): DoePlanState {
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
			reviewFeedback: feedback,
		},
		pendingReview: null,
	};
}

async function registerResumeTool(input: {
	client: FailingPlanClient;
	registry: DoeRegistry;
	templatesDir: string;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState) => DoePlanState;
}): Promise<RegisteredTool> {
	const registerPlanResumeTool = await loadPlanResumeTool();
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
	};
	Reflect.apply(registerPlanResumeTool, undefined, [pi, {
		client: input.client,
		registry: input.registry,
		templatesDir: input.templatesDir,
		startReviewPlan: () => {
			throw new Error("unexpected review start");
		},
		getSessionSlug: () => "feature-x",
		getPlanState: input.getPlanState,
		setPlanState: input.setPlanState,
	}]);
	const resume = tools.get("plan_resume");
	if (!resume) {
		throw new Error("plan_resume tool was not registered");
	}
	return resume;
}

async function createRegressionHarness() {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-resume-regression-"));
	const templatesDir = join(repoRoot, "templates");
	createPlanTemplate(templatesDir);
	const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
	mkdirSync(dirname(planFilePath), { recursive: true });
	writeFileSync(planFilePath, "# Draft\n\nInitial plan.\n", "utf-8");
	const previousCwd = process.cwd();
	process.chdir(repoRoot);
	const feedback = "# Plan Feedback\n\nAdd rollout and testing.";
	let planState = createNeedsRevisionState(planFilePath, feedback);
	const registry = new DoeRegistry();
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: createRegistryAgent({
			id: "agent-1",
			threadId: "thread-1",
			state: "completed",
			activeTurnId: null,
			completedAt: Date.now(),
		}),
	});
	const client = new FailingPlanClient();
	const resume = await registerResumeTool({
		client,
		registry,
		templatesDir,
		getPlanState: () => planState,
		setPlanState: (updater) => {
			planState = updater(planState);
			return planState;
		},
	});

	return {
		client,
		resume,
		feedback,
		readPlanState: () => planState,
		restoreCwd: () => process.chdir(previousCwd),
	};
}

test("plan_resume restores needs_revision feedback when revision turn start fails", {
	concurrency: false,
}, async () => {
	const harness = await createRegressionHarness();
	try {
		await assert.rejects(
			harness.resume.execute("tool-resume", { commentary: "Keep scope tight." }, undefined),
			/failed to start revision turn/,
		);
		assert.equal(harness.client.resumeCalls.length, 1);
		assert.equal(harness.client.turnCalls.length, 1);
		assert.equal(harness.readPlanState().activePlan?.status, "needs_revision");
		assert.equal(harness.readPlanState().activePlan?.reviewFeedback, harness.feedback);
		assert.equal(harness.readPlanState().pendingReview, null);
	} finally {
		harness.restoreCwd();
	}
});
