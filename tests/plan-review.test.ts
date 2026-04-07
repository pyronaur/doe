import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./test-runner.ts";
import {
	buildPlannotatorRequest,
	parsePlannotatorReviewResult,
	runPlanReviewCli,
} from "../src/plan/review.ts";

function makeFakePlannotator(output: string) {
	const dir = mkdtempSync(join(tmpdir(), "doe-plannotator-"));
	const capturePath = join(dir, "stdin.json");
	const binPath = join(dir, "plannotator");
	const script = [
		"#!/bin/sh",
		`cat > "${capturePath}"`,
		`printf '%s' "${output.replaceAll('"', '\\"')}"`,
	].join("\n");

	writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
	chmodSync(binPath, 0o755);

	return {
		capturePath,
		binDir: dir,
	};
}

test("buildPlannotatorRequest serializes the full plan content", () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-review-request-"));
	const planFilePath = join(repoRoot, "plan.md");
	const planText = "# Plan\n\nShip the change.\n";
	writeFileSync(planFilePath, planText, "utf-8");

	assert.equal(
		buildPlannotatorRequest(planFilePath),
		JSON.stringify({
			tool_input: {
				plan: planText,
			},
		}),
	);
});

test("parsePlannotatorReviewResult approves allow decisions", () => {
	assert.deepEqual(
		parsePlannotatorReviewResult(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "allow",
					},
				},
			}),
		),
		{
			status: "approved",
			feedback: null,
		},
	);
});

test("parsePlannotatorReviewResult preserves deny feedback", () => {
	assert.deepEqual(
		parsePlannotatorReviewResult(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "deny",
						message: "YOUR PLAN WAS NOT APPROVED.\n\nAdd rollout guidance.",
					},
				},
			}),
		),
		{
			status: "needs_revision",
			feedback: "YOUR PLAN WAS NOT APPROVED.\n\nAdd rollout guidance.",
		},
	);
});

test("parsePlannotatorReviewResult rejects invalid stdout", () => {
	assert.throws(() => {
		parsePlannotatorReviewResult("not json");
	}, /not valid JSON/);
});

test("runPlanReviewCli sends the plan text to plannotator stdin and approves allow", async () => {
	const fake = makeFakePlannotator(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: {
					behavior: "allow",
				},
			},
		}),
	);
	const planText = "# Plan\n\nShip the change.\n";
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-review-run-"));
	const planFilePath = join(repoRoot, "plan.md");
	writeFileSync(planFilePath, planText, "utf-8");
	const originalPath = process.env.PATH;
	process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;

	try {
		const result = await runPlanReviewCli({
			planFilePath,
			cwd: repoRoot,
		});

		assert.deepEqual(result, {
			status: "approved",
			feedback: null,
		});
		assert.equal(
			readFileSync(fake.capturePath, "utf-8"),
			JSON.stringify({
				tool_input: {
					plan: planText,
				},
			}),
		);
	} finally {
		if (originalPath === undefined) {
			delete process.env.PATH;
		}
		if (originalPath !== undefined) {
			process.env.PATH = originalPath;
		}
	}
});

test("runPlanReviewCli returns revision feedback for deny decisions", async () => {
	const fake = makeFakePlannotator(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: {
					behavior: "deny",
					message: "YOUR PLAN WAS NOT APPROVED.\n\nAdd rollout guidance.",
				},
			},
		}),
	);
	const planText = "# Plan\n\nShip the change.\n";
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-review-run-"));
	const planFilePath = join(repoRoot, "plan.md");
	writeFileSync(planFilePath, planText, "utf-8");
	const originalPath = process.env.PATH;
	process.env.PATH = `${fake.binDir}:${originalPath ?? ""}`;

	try {
		const result = await runPlanReviewCli({
			planFilePath,
			cwd: repoRoot,
		});

		assert.deepEqual(result, {
			status: "needs_revision",
			feedback: "YOUR PLAN WAS NOT APPROVED.\n\nAdd rollout guidance.",
		});
		assert.equal(
			readFileSync(fake.capturePath, "utf-8"),
			JSON.stringify({
				tool_input: {
					plan: planText,
				},
			}),
		);
	} finally {
		if (originalPath === undefined) {
			delete process.env.PATH;
		}
		if (originalPath !== undefined) {
			process.env.PATH = originalPath;
		}
	}
});
