import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlanResumePrompt,
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
		reviewFeedback: "Add rollout and test coverage.",
		commentary: "Keep scope limited to the auth service.",
		planFilePath: "/repo/.tmp/feature-x/plan-auth-refactor.md",
		sharedKnowledgebasePath: "/repo/.tmp/feature-x",
	});
	assert.match(prompt, /<review_feedback>/);
	assert.match(prompt, /Add rollout and test coverage\./);
	assert.match(prompt, /<\/review_feedback>/);
	assert.match(prompt, /<director_commentary>/);
	assert.match(prompt, /Keep scope limited to the auth service\./);
	assert.match(prompt, /<\/director_commentary>/);
	assert.match(prompt, /Rewrite the plan only at: \/repo\/.tmp\/feature-x\/plan-auth-refactor\.md/);
});
