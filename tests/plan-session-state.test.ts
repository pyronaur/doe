import test from "node:test";
import assert from "node:assert/strict";
import {
	createEmptyPlanState,
	restoreLatestPlanState,
	serializePlanState,
	type DoePlanState,
} from "../src/plan/session-state.ts";

test("restoreLatestPlanState returns defaults when no plan entry exists", () => {
	assert.deepEqual(restoreLatestPlanState([]), createEmptyPlanState());
});

test("restoreLatestPlanState uses the latest doe-plan-state entry and normalizes missing fields", () => {
	const state = restoreLatestPlanState([
		{ type: "custom", customType: "other", data: { ignored: true } },
		{
			type: "custom",
			customType: "doe-plan-state",
			data: {
				sessionSlugReminderSentAtTurn: 4,
				activePlan: {
					planSlug: "alpha",
					planFilePath: "/tmp/alpha.md",
					agentId: "agent-1",
					threadId: "thread-1",
					startedAt: 10,
				},
			},
		},
		{
			type: "custom",
			customType: "doe-plan-state",
			data: {
				pendingReview: {
					planSlug: "beta",
					reviewId: "review-1",
					requestedAt: 20,
				},
			},
		},
	]);

	assert.equal(state.version, 1);
	assert.equal(state.sessionSlugReminderSentAtTurn, null);
	assert.equal(state.activePlan, null);
	assert.deepEqual(state.pendingReview, {
		planSlug: "beta",
		reviewId: "review-1",
		requestedAt: 20,
	});
});

test("serializePlanState clones nested state", () => {
	const initial: DoePlanState = {
		version: 1,
		sessionSlugReminderSentAtTurn: 3,
		activePlan: {
			planSlug: "plan-a",
			planFilePath: "/tmp/plan-a.md",
			agentId: "agent-1",
			threadId: null,
			startedAt: 123,
		},
		pendingReview: null,
	};

	const cloned = serializePlanState(initial);
	assert.deepEqual(cloned, initial);
	assert.notEqual(cloned, initial);
	assert.notEqual(cloned.activePlan, initial.activePlan);
});
