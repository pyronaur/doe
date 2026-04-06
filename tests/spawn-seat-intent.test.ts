import test from "node:test";
import assert from "node:assert/strict";
import { DoeRegistry } from "../src/state/registry.ts";
import { normalizeSpawnSeatIntent } from "../src/tools/spawn-seat-intent.ts";

test("known seat names in name are treated as seat intent when ic is omitted", () => {
	const registry = new DoeRegistry();
	const normalized = normalizeSpawnSeatIntent(
		{ name: "Hope", prompt: "Investigate session roster failure" },
		(name) => Boolean(registry.findSeat(name)),
	);

	assert.equal(normalized.ic, "Hope");
	assert.equal(normalized.taskName, "Investigate session");
});

test("non-seat names remain task labels when ic is omitted", () => {
	const registry = new DoeRegistry();
	const normalized = normalizeSpawnSeatIntent(
		{ name: "Investigate auth", prompt: "Investigate session roster failure" },
		(name) => Boolean(registry.findSeat(name)),
	);

	assert.equal(normalized.ic, null);
	assert.equal(normalized.taskName, "Investigate auth");
});

test("explicit ic wins even when name is another known seat", () => {
	const registry = new DoeRegistry();
	const normalized = normalizeSpawnSeatIntent(
		{ name: "Peter", ic: "Hope", prompt: "Investigate session roster failure" },
		(name) => Boolean(registry.findSeat(name)),
	);

	assert.equal(normalized.ic, "Hope");
	assert.equal(normalized.taskName, "Peter");
});
