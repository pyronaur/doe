import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const DOE_ROOT = "/Users/n14/.pi/agent/extensions/doe";

function runIsolatedIndexProbe() {
	const script = `
		import { basename } from "node:path";
		import { mock } from "bun:test";

		mock.module("@mariozechner/pi-coding-agent", () => ({
			isToolCallEventType: () => false,
		}));

		mock.module("./src/codex/app-server-client.js", () => ({
			CodexAppServerClient: class CodexAppServerClient {
				on() {}
				close() {}
			},
		}));

		mock.module("./src/codex/model-selection.js", () => ({
			validateModelId: (value) => value,
		}));

		mock.module("./src/plan/session-state.js", () => ({
			DOE_PLAN_STATE_TYPE: "doe-plan-state",
			clonePlanState: (value) => value,
			createEmptyPlanState: () => ({}),
			restoreLatestPlanState: () => ({}),
			serializePlanState: (value) => value,
		}));

		mock.module("./src/plan/review.js", () => ({
			runPlanReviewCli: async () => ({ status: "approved", feedback: null }),
		}));

		mock.module("./src/plan/reminder.js", () => ({
			estimateCurrentTurnIndex: () => 0,
			shouldInjectSessionSlugReminder: () => false,
		}));

		mock.module("./src/roster/registry.js", () => ({
			DoeRegistry: class DoeRegistry {
				listRosterAssignments() {
					return [];
				}
				on() {}
			},
		}));

		mock.module("./src/ui/agent-live-view.js", () => ({
			AgentLiveViewController: class AgentLiveViewController {
				requestRender() {}
				toggle() {}
			},
		}));

		mock.module("./src/ui/doe-status.js", () => ({
			formatDoeStatus: () => "status",
		}));

		mock.module("./src/templates/loader.js", () => ({
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
			"./src/tools/plan-start.js",
			"./src/tools/plan-resume.js",
			"./src/tools/plan-stop.js",
			"./src/tools/session-set.js",
			"./src/tools/spawn.js",
			"./src/tools/resume.js",
			"./src/tools/list.js",
			"./src/tools/inspect.js",
			"./src/tools/cancel.js",
			"./src/tools/finalize.js",
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

	return JSON.parse(
		execFileSync("bun", ["-e", script], {
			cwd: DOE_ROOT,
			encoding: "utf8",
		}),
	) as {
		roster: string;
		guidance: string;
	};
}

test("formatCompactRosterSummary groups ICs by role in config order", () => {
	const result = runIsolatedIndexProbe();

	assert.equal(
		result.roster,
		"IC roster: researcher: Tony, Bruce | senior: Strange, Scott | mid: Peter, Sam | junior: Jane, Pepper | intern: Hope",
	);
});

test("buildGuidanceMessage appends the compact roster summary", () => {
	const result = runIsolatedIndexProbe();

	assert.equal(
		result.guidance,
		[
			"SYSTEM",
			"DECISION",
			"IC roster: researcher: Tony, Bruce | senior: Strange, Scott | mid: Peter, Sam | junior: Jane, Pepper | intern: Hope",
		].join("\n\n"),
	);
});
