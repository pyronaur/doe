import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import type { DoePlanState } from "../plan/session-state.js";
import type { DoeRegistry } from "../roster/registry.js";

interface PlanStopToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState, options?: { flush?: boolean }) => DoePlanState;
}

export function registerPlanStopTool(pi: ExtensionAPI, deps: PlanStopToolDeps) {
	pi.registerTool({
		name: "plan_stop",
		label: "Plan Stop",
		description: "Abandon the current planning workflow and clear active plan state.",
		promptSnippet: "Exit the current planning workflow.",
		promptGuidelines: [
			"Use this to abandon the current plan and clear active planning state.",
		],
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "plan_stop"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "plan_stop"), 0, 0);
		},
		async execute() {
			const state = deps.getPlanState();
			const activePlan = state.activePlan;
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "Planning mode is already idle." }],
					details: { interrupted: false },
				};
			}

			let interrupted = false;
			if (activePlan?.agentId) {
				const agent = deps.registry.findAgent(activePlan.agentId);
				if (agent?.threadId && agent.activeTurnId && agent.state === "working") {
					await deps.client.interruptTurn(agent.threadId, agent.activeTurnId);
					deps.registry.markAwaitingInput(agent.threadId, "Planning workflow stopped.");
					interrupted = true;
				}
			}

			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: null,
				}),
				{ flush: true },
			);

			return {
				content: [{
					type: "text",
					text: `Stopped planning workflow for ${activePlan.planSlug}.`,
				}],
				details: {
					interrupted,
					planSlug: activePlan?.planSlug ?? null,
				},
			};
		},
	});
}
