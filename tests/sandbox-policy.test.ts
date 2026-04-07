import assert from "node:assert/strict";
import { test } from "./test-runner.ts";
import { mockToolModules } from "./tool-module-mocks.ts";

mockToolModules({
	includeContainer: true,
	includePiAi: true,
	includeTypeboxCollections: true,
});

const spawnModule = await import("../src/tools/spawn.ts");
const resumeModule = await import("../src/tools/resume.ts");

const cases = [
	{ role: "researcher", sandbox: undefined, mode: "danger-full-access" },
	{ role: "researcher", sandbox: "workspace-write", mode: "danger-full-access" },
	{ role: "researcher", sandbox: "danger-full-access", mode: "danger-full-access" },
	{ role: "senior", sandbox: undefined, mode: "danger-full-access" },
	{ role: "senior", sandbox: "workspace-write", mode: "danger-full-access" },
	{ role: "senior", sandbox: "danger-full-access", mode: "danger-full-access" },
	{ role: "mid", sandbox: undefined, mode: "workspace-write" },
	{ role: "mid", sandbox: "workspace-write", mode: "workspace-write" },
	{ role: "mid", sandbox: "danger-full-access", mode: "danger-full-access" },
	{ role: null, sandbox: undefined, mode: "read-only" },
	{ role: null, sandbox: "workspace-write", mode: "read-only" },
	{ role: null, sandbox: "danger-full-access", mode: "read-only" },
] as const;

test("spawn sandbox policy matches the DOE role matrix", () => {
	for (const entry of cases) {
		assert.equal(spawnModule.resolveSandboxMode(entry.role, entry.sandbox), entry.mode);
	}
});

test("resume sandbox policy matches the DOE role matrix", () => {
	for (const entry of cases) {
		assert.equal(resumeModule.resolveSandboxMode(entry.role, entry.sandbox), entry.mode);
	}
});
