import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlanResumePrompt,
	formatPlanReviewCommand,
	formatPlanReuseError,
	getSharedKnowledgebaseContext,
	injectSharedKnowledgebaseContext,
	preparePlanFile,
} from "../src/plan/flow.ts";

test("injectSharedKnowledgebaseContext prefixes the shared session directory", () => {
	const context = getSharedKnowledgebaseContext("/repo", "feature-x");
	const prompt = injectSharedKnowledgebaseContext("Inspect the auth flow.", context);
	assert.match(prompt, /Session slug: feature-x/);
	assert.match(prompt, /Shared knowledgebase directory: \/repo\/.tmp\/feature-x/);
	assert.match(prompt, /Inspect the auth flow\./);
});

test("preparePlanFile requires explicit reuse when the plan file already exists", () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-flow-"));
	const planFilePath = join(repoRoot, ".tmp", "feature-x", "plan-auth-refactor.md");
	mkdirSync(join(repoRoot, ".tmp", "feature-x"), { recursive: true });
	writeFileSync(planFilePath, "# Existing plan\n", { encoding: "utf-8", flag: "w" });

	const blocked = preparePlanFile({
		repoRoot,
		sessionSlug: "feature-x",
		planSlug: "auth refactor",
	});
	assert.equal(blocked.planSlug, "auth-refactor");
	assert.equal(blocked.planFilePath, planFilePath);
	assert.equal(blocked.requiresAllowExisting, true);
	assert.match(formatPlanReuseError(blocked), /allowExisting=true/);
});

test("buildPlanResumePrompt includes feedback, commentary, and fixed output path", () => {
	const prompt = buildPlanResumePrompt({
		feedback: "Add rollout and test coverage.",
		commentary: "Keep scope limited to the auth service.",
		planFilePath: "/repo/.tmp/feature-x/plan-auth-refactor.md",
		sharedKnowledgebasePath: "/repo/.tmp/feature-x",
	});
	assert.match(prompt, /CTO Review Feedback/);
	assert.match(prompt, /Add rollout and test coverage\./);
	assert.match(prompt, /Keep scope limited to the auth service\./);
	assert.match(prompt, /Rewrite the plan only at: \/repo\/.tmp\/feature-x\/plan-auth-refactor\.md/);
});

test("formatPlanReviewCommand returns the plannotator annotate step for the plan file", () => {
	assert.equal(
		formatPlanReviewCommand("/repo/.tmp/feature-x/plan-auth-refactor.md"),
		"!plannotator annotate /repo/.tmp/feature-x/plan-auth-refactor.md",
	);
});
