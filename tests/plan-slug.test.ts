import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPlanFilePath,
	getSessionWorkspacePath,
	normalizePlanSlug,
	normalizeSessionSlug,
	prepareSessionWorkspace,
} from "../src/plan/slug.ts";
import { test } from "./test-runner.ts";

test("normalizeSessionSlug slugifies user input", () => {
	assert.equal(normalizeSessionSlug(" Feature X / 2026 "), "feature-x-2026");
});

test("normalizePlanSlug rejects empty slugs after normalization", () => {
	assert.throws(() => normalizePlanSlug("!!!"),
		/planSlug must contain at least one letter or number/);
});

test("session workspace and plan file paths stay under .tmp/session-slug", () => {
	const repoRoot = "/repo";
	assert.equal(getSessionWorkspacePath(repoRoot, "Feature X"), "/repo/.tmp/feature-x");
	assert.equal(getPlanFilePath(repoRoot, "Feature X", "Auth Refactor"),
		"/repo/.tmp/feature-x/plan-auth-refactor.md");
});

test("prepareSessionWorkspace requires explicit allowExisting for non-empty workspaces", () => {
	const repoRoot = mkdtempSync(join(tmpdir(), "doe-plan-"));
	const workspacePath = join(repoRoot, ".tmp", "feature-x");
	mkdirSync(workspacePath, { recursive: true });
	writeFileSync(join(workspacePath, "notes.md"), "# notes\n");

	const blocked = prepareSessionWorkspace({
		repoRoot,
		sessionSlug: "Feature X",
	});
	assert.equal(blocked.sessionSlug, "feature-x");
	assert.equal(blocked.workspacePath, workspacePath);
	assert.equal(blocked.requiresAllowExisting, true);
	assert.deepEqual(blocked.existingEntries, ["notes.md"]);

	const allowed = prepareSessionWorkspace({
		repoRoot,
		sessionSlug: "Feature X",
		allowExisting: true,
	});
	assert.equal(allowed.requiresAllowExisting, false);
});
