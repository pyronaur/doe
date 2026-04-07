import assert from "node:assert/strict";
import { deriveUsageSnapshot } from "../src/context-usage.ts";
import { DoeRegistry } from "../src/roster/registry.ts";
import type { AgentRecord } from "../src/roster/types.ts";
import { formatDoeStatus } from "../src/ui/doe-status.ts";
import { attachSeatAgent, requireRegistryAgent } from "./registry-fixtures.ts";
import { test } from "./test-runner.ts";

function attachAgent(
	registry: DoeRegistry,
	input: {
		agentId: string;
		ic: string;
		state?: AgentRecord["state"];
		usagePercent?: number;
	},
) {
	attachSeatAgent(registry, {
		agentId: input.agentId,
		ic: input.ic,
		agent: {
			activityLabel: "thinking",
			latestSnippet: "latest",
			runStartedAt: 1,
			state: input.state ?? "working",
			usage: typeof input.usagePercent === "number"
				? deriveUsageSnapshot({ tokensUsed: input.usagePercent, tokenLimit: 100 }, null, 1)
				: null,
		},
	});
}

test("DOE status expands the bottom summary without the compass emoji", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 60 });
	attachAgent(registry, { agentId: "agent-2", ic: "Strange", usagePercent: 21 });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope", state: "awaiting_input" });
	registry.markAwaitingInput("agent-3-thread", "waiting");

	assert.equal(formatDoeStatus(registry),
		"3 Occupied ICs: Tony[work 60%] | Strange[work 21%] | Hope[wait ?]");
});

test("DOE status keeps all occupied seats visible and hides restored-stale capacity behind a question mark", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 60 });
	attachAgent(registry, { agentId: "agent-2", ic: "Peter", usagePercent: 100 });
	attachAgent(registry, { agentId: "agent-3", ic: "Hope", state: "completed" });
	registry.markAwaitingInput("agent-2-thread", "waiting");
	registry.upsertAgent({
		...requireRegistryAgent(registry, "agent-2"),
		recovered: true,
	});

	assert.equal(formatDoeStatus(registry),
		"3 Occupied ICs: Tony[work 60%] | Peter[wait ?] | Hope[done ?]");
});

test("DOE status shows restored capacity again after a fresh usage update arrives", () => {
	const registry = new DoeRegistry();
	attachAgent(registry, { agentId: "agent-1", ic: "Tony", usagePercent: 100 });
	registry.upsertAgent({
		...requireRegistryAgent(registry, "agent-1"),
		recovered: true,
	});

	assert.equal(formatDoeStatus(registry), "1 Occupied IC: Tony[work ?]");

	registry.markTokenUsage("agent-1-thread", "turn-2", { tokensUsed: 42, tokenLimit: 100 });

	assert.equal(formatDoeStatus(registry), "1 Occupied IC: Tony[work 42%]");
});
