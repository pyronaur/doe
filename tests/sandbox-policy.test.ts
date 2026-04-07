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
	{ role: "senior", allowWrite: false, sandbox: "danger-full-access" },
	{ role: "senior", allowWrite: true, sandbox: "danger-full-access" },
	{ role: "mid", allowWrite: false, sandbox: "read-only" },
	{ role: "mid", allowWrite: true, sandbox: "danger-full-access" },
	{ role: "research", allowWrite: false, sandbox: "read-only" },
	{ role: "research", allowWrite: true, sandbox: "read-only" },
] as const;

test("spawn sandbox policy matches the DOE role matrix", () => {
	for (const entry of cases) {
		assert.equal(spawnModule.resolveSandboxMode(entry.role, entry.allowWrite), entry.sandbox);
	}
});

test("resume sandbox policy matches the DOE role matrix", () => {
	for (const entry of cases) {
		assert.equal(resumeModule.resolveSandboxMode(entry.role, entry.allowWrite), entry.sandbox);
	}
});
