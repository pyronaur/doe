import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoePlanReviewResult } from "../src/plan/review.ts";
import { DoePlanReviewCoordinator } from "../src/plan/runtime-review.ts";
import type { DoePlanState } from "../src/plan/session-state.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import { attachSeatAgent, createRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

function createPlanState(initial: DoePlanState) {
	let current = initial;
	return {
		get: () => current,
		set: (updater: (state: DoePlanState) => DoePlanState) => {
			current = updater(current);
			return current;
		},
	};
}

function createDraftingState(planFilePath: string): DoePlanState {
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
			status: "drafting",
			reviewFeedback: null,
		},
		pendingReview: null,
	};
}

function createTempPlanFile() {
	const dir = mkdtempSync(join(tmpdir(), "doe-runtime-review-"));
	const planFilePath = join(dir, "plan.md");
	writeFileSync(planFilePath, "# Draft\n\nPlan text.\n", "utf-8");
	return planFilePath;
}

test("coordinator persists pending review before startup wait resolves", async () => {
	const planFilePath = createTempPlanFile();
	const registry = new DoeRegistry();
	const planState = createPlanState(createDraftingState(planFilePath));
	attachSeatAgent(registry, {
		agentId: "agent-1",
		ic: "Hope",
		threadId: "thread-1",
		agent: createRegistryAgent({
			id: "agent-1",
			threadId: "thread-1",
			cwd: "/tmp",
			state: "completed",
			activeTurnId: null,
		}),
	});

	let resolveStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let resolveWait!: (value: DoePlanReviewResult) => void;
	const wait = new Promise<DoePlanReviewResult>((resolve) => {
		resolveWait = resolve;
	});

	const coordinator = new DoePlanReviewCoordinator({
		registry,
		getPlanState: planState.get,
		setPlanState: (updater) => planState.set(updater),
		startReviewPlan: () => ({
			reviewId: "review-1",
			started,
			wait,
			isAlive: () => true,
		}),
	});

	coordinator.onAgentTerminal(createRegistryAgent({
		id: "agent-1",
		threadId: "thread-1",
		state: "completed",
	}));
	await Promise.resolve();

	assert.equal(planState.get().activePlan?.status, "ready_for_review");
	assert.equal(planState.get().pendingReview?.reviewId, "review-1");

	resolveStarted();
	resolveWait({ status: "approved", feedback: null });
	await Promise.resolve();
});

test("coordinator restore handles synchronous review startup throw", () => {
	const planFilePath = createTempPlanFile();
	const registry = new DoeRegistry();
	const initial = createDraftingState(planFilePath);
	const activePlan = initial.activePlan;
	assert.ok(activePlan);
	initial.activePlan = {
		...activePlan,
		status: "ready_for_review",
	};
	initial.pendingReview = {
		reviewId: "review-1",
		sessionSlug: "feature-x",
		planSlug: "auth-refactor",
		planFilePath,
		agentId: "agent-1",
		requestedAt: Date.now(),
	};
	const planState = createPlanState(initial);
	const coordinator = new DoePlanReviewCoordinator({
		registry,
		getPlanState: planState.get,
		setPlanState: (updater) => planState.set(updater),
		startReviewPlan: () => {
			throw new Error("boom");
		},
	});

	assert.doesNotThrow(() => coordinator.onRestore());
	assert.equal(planState.get().pendingReview, null);
	assert.equal(planState.get().activePlan?.status, "ready_for_review");
	assert.equal(planState.get().activePlan?.reviewFeedback, null);
});
