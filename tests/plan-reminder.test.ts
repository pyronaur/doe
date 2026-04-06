import test from "node:test";
import assert from "node:assert/strict";
import { estimateCurrentTurnIndex, shouldInjectSessionSlugReminder } from "../src/plan/reminder.ts";

test("estimateCurrentTurnIndex counts prior assistant turns", () => {
	assert.equal(
		estimateCurrentTurnIndex([
			{ role: "user" },
			{ role: "assistant" },
			{ role: "tool" },
			{ role: "assistant" },
		]),
		3,
	);
});

test("shouldInjectSessionSlugReminder starts on turn three and avoids same-turn repeats", () => {
	assert.equal(
		shouldInjectSessionSlugReminder({
			sessionSlug: null,
			currentTurn: 2,
			lastReminderTurn: null,
		}),
		false,
	);
	assert.equal(
		shouldInjectSessionSlugReminder({
			sessionSlug: null,
			currentTurn: 3,
			lastReminderTurn: null,
		}),
		true,
	);
	assert.equal(
		shouldInjectSessionSlugReminder({
			sessionSlug: null,
			currentTurn: 3,
			lastReminderTurn: 3,
		}),
		false,
	);
	assert.equal(
		shouldInjectSessionSlugReminder({
			sessionSlug: "feature-x",
			currentTurn: 4,
			lastReminderTurn: null,
		}),
		false,
	);
});
