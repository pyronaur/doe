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
					ic: "Hope",
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
				sessionSlugReminderSentAtTurn: 9,
				activePlan: {
					planSlug: "beta",
					planFilePath: "/tmp/beta.md",
					agentId: "agent-2",
					threadId: "thread-2",
					startedAt: 20,
				},
			},
		},
	]);

	assert.equal(state.version, 3);
	assert.equal(state.sessionSlugReminderSentAtTurn, 9);
	assert.deepEqual(state.activePlan, {
		planSlug: "beta",
		planFilePath: "/tmp/beta.md",
		ic: null,
		agentId: "agent-2",
		threadId: "thread-2",
	});
});

test("serializePlanState clones nested state", () => {
	const initial: DoePlanState = {
		version: 3,
		sessionSlugReminderSentAtTurn: 3,
		activePlan: {
			planSlug: "plan-a",
			planFilePath: "/tmp/plan-a.md",
			ic: "Hope",
			agentId: "agent-1",
			threadId: null,
		},
	};

	const cloned = serializePlanState(initial);
	assert.deepEqual(cloned, initial);
	assert.notEqual(cloned, initial);
	assert.notEqual(cloned.activePlan, initial.activePlan);
});
