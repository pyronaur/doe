import test from "node:test";
import assert from "node:assert/strict";
import { parsePlanReviewResult } from "../src/plan/review.ts";

test("parsePlanReviewResult treats empty annotate feedback as approval", () => {
	assert.deepEqual(parsePlanReviewResult("No feedback provided.\n"), {
		status: "approved",
		feedback: null,
	});
});

test("parsePlanReviewResult preserves revision feedback", () => {
	assert.deepEqual(parsePlanReviewResult("# Plan Feedback\n\nAdd rollout guidance.\n"), {
		status: "needs_revision",
		feedback: "# Plan Feedback\n\nAdd rollout guidance.",
	});
});
