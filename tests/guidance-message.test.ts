import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "./test-runner.ts";

const DOE_ROOT = "/Users/n14/.pi/agent/extensions/doe";

interface ProbeResult {
	roster: string;
	guidance: string;
}

const PROBE_SCRIPT = `
	import { basename } from "node:path";
	import { mock } from "bun:test";

	mock.module("@mariozechner/pi-coding-agent", () => ({
		isToolCallEventType: () => false,
	}));

	mock.module("./src/codex/app-server-client.ts", () => ({
		CodexAppServerClient: class CodexAppServerClient {
			on() {}
			close() {}
		},
	}));

	mock.module("./src/codex/model-selection.ts", () => ({
		validateModelId: (value) => value,
	}));

	mock.module("./src/plan/session-state.ts", () => ({
		DOE_PLAN_STATE_TYPE: "doe-plan-state",
		clonePlanState: (value) => value,
		createEmptyPlanState: () => ({}),
		restoreLatestPlanState: () => ({}),
		serializePlanState: (value) => value,
	}));

	mock.module("./src/plan/review.ts", () => ({
		runPlanReviewCli: async () => ({ status: "approved", feedback: null }),
		startPlanReviewCli: () => ({
			reviewId: "review-1",
			wait: Promise.resolve({ status: "approved", feedback: null }),
		}),
	}));

	mock.module("./src/plan/reminder.ts", () => ({
		estimateCurrentTurnIndex: () => 0,
		shouldInjectSessionSlugReminder: () => false,
	}));

	mock.module("./src/roster/registry.ts", () => ({
		DoeRegistry: class DoeRegistry {
			listRosterAssignments() {
				return [];
			}
			on() {}
		},
	}));

	mock.module("./src/ui/agent-live-controller.ts", () => ({
		AgentLiveViewController: class AgentLiveViewController {
			requestRender() {}
			toggle() {}
		},
	}));

	mock.module("./src/ui/doe-status.ts", () => ({
		formatDoeStatus: () => "status",
	}));

	mock.module("./src/templates/loader.ts", () => ({
		loadMarkdownDoc: (path) => {
			const name = basename(path);
			if (name === "doe-system.md") return { body: "SYSTEM" };
			if (name === "decision-guidance.md") return { body: "DECISION" };
			return null;
		},
		loadMarkdownDocs: () => [],
		summarizeTemplates: () => "",
	}));

	for (const path of [
		"./src/tools/plan-start.ts",
		"./src/tools/plan-resume.ts",
		"./src/tools/plan-stop.ts",
		"./src/tools/session-set.ts",
		"./src/tools/spawn.ts",
		"./src/tools/resume.ts",
		"./src/tools/list.ts",
		"./src/tools/inspect.ts",
		"./src/tools/cancel.ts",
		"./src/tools/finalize.ts",
	]) {
		mock.module(path, () => ({
			registerPlanStartTool: () => {},
			registerPlanResumeTool: () => {},
			registerPlanStopTool: () => {},
			registerSessionSetTool: () => {},
			registerSpawnTool: () => {},
			registerResumeTool: () => {},
			registerListTool: () => {},
			registerInspectTool: () => {},
			registerCancelTool: () => {},
			registerFinalizeTool: () => {},
		}));
	}

	mock.module("./src/read-gate.ts", () => ({
		ensureReadToolActive: (tools) => tools,
		evaluateReadGate: () => undefined,
	}));

	const { formatCompactRosterSummary, buildGuidanceMessage } = await import("./index.ts");
	process.stdout.write(JSON.stringify({
		roster: formatCompactRosterSummary(),
		guidance: await buildGuidanceMessage(),
	}));
`;

function parseProbeResult(raw: string): ProbeResult {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Probe output is not an object.");
	}
	const roster = Reflect.get(parsed, "roster");
	const guidance = Reflect.get(parsed, "guidance");
	if (typeof roster !== "string" || typeof guidance !== "string") {
		throw new Error("Probe output is missing required fields.");
	}
	return { roster, guidance };
}

function runIsolatedIndexProbe(): ProbeResult {
	return parseProbeResult(
		execFileSync("bun", ["-e", PROBE_SCRIPT], {
			cwd: DOE_ROOT,
			encoding: "utf8",
		}),
	);
}

test("formatCompactRosterSummary groups ICs by role in config order", () => {
	const result = runIsolatedIndexProbe();

	assert.equal(
		result.roster,
		"IC roster: senior: Tony, Bruce, Strange | mid: Peter, Sam, Scott | researcher: Hope, Jane, Pepper",
	);
});

test("buildGuidanceMessage appends the compact roster summary", () => {
	const result = runIsolatedIndexProbe();

	assert.equal(
		result.guidance,
		[
			"SYSTEM",
			"DECISION",
			"IC roster: senior: Tony, Bruce, Strange | mid: Peter, Sam, Scott | researcher: Hope, Jane, Pepper",
		].join("\n\n"),
	);
});
