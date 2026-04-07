import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("@sinclair/typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: () => ({ type: "string" }),
		Optional: (value: unknown) => value,
		Boolean: () => ({ type: "boolean" }),
		Record: (key: unknown, value: unknown) => ({ type: "record", key, value }),
		Any: () => ({ type: "any" }),
		Array: (value: unknown) => ({ type: "array", value }),
	},
}));

mock.module("@mariozechner/pi-ai", () => ({
	StringEnum: (value: unknown) => value,
}));

mock.module("@mariozechner/pi-tui", () => ({
	Container: class Container {},
	Text: class Text {
		constructor(
			public readonly text: string,
			public readonly x = 0,
			public readonly y = 0,
		) {}
	},
}));

mock.module("@mariozechner/pi-coding-agent", () => ({}));

const spawnModule = await import("../src/tools/spawn.ts");
const resumeModule = await import("../src/tools/resume.ts");

const cases = [
	{ role: "senior", sandbox: undefined, mode: "danger-full-access" },
	{ role: "senior", sandbox: "workspace-write", mode: "danger-full-access" },
	{ role: "senior", sandbox: "danger-full-access", mode: "danger-full-access" },
	{ role: "mid", sandbox: undefined, mode: "workspace-write" },
	{ role: "mid", sandbox: "workspace-write", mode: "workspace-write" },
	{ role: "mid", sandbox: "danger-full-access", mode: "danger-full-access" },
	{ role: "research", sandbox: undefined, mode: "read-only" },
	{ role: "research", sandbox: "workspace-write", mode: "read-only" },
	{ role: "research", sandbox: "danger-full-access", mode: "read-only" },
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
