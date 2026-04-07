import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { truncateForDisplay } from "../codex/client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import {
	buildPlanResumePrompt,
	getSharedKnowledgebaseContext,
	readPlanFile,
} from "../plan/flow.js";
import type { DoePlanState } from "../plan/session-state.js";
import type { DoeRegistry } from "../roster/registry.js";

interface PlanResumeToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	getSessionSlug: () => string | null;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState, options?: { flush?: boolean }) => DoePlanState;
	requestPlanReview: (input: { planContent: string; planFilePath: string }) => Promise<{ reviewId: string }>;
}

function resolveAgentFinalOutput(agent: any): string {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) => message?.role === "agent" && typeof message?.text === "string" && message.text.trim().length > 0)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? "Completed";
}

export function registerPlanResumeTool(pi: ExtensionAPI, deps: PlanResumeToolDeps) {
	pi.registerTool({
		name: "plan_resume",
		label: "Plan Resume",
		description: "Continue the current plan after review feedback.",
		promptSnippet: "Continue the current plan after review feedback.",
		promptGuidelines: [
			"Use this only after a plan review has produced feedback.",
			"Pass CTO feedback and optional DoE commentary for the same active plan.",
		],
		parameters: Type.Object({
			feedback: Type.String(),
			commentary: Type.Optional(Type.String()),
		}),
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "plan_resume"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "plan_resume"), 0, 0);
		},
		async execute(_toolCallId, params, signal) {
			const sessionSlug = deps.getSessionSlug();
			if (!sessionSlug) {
				throw new Error("No canonical session slug is set. Call session_set before plan_resume.");
			}

			const state = deps.getPlanState();
			if (state.pendingReview) {
				throw new Error(`Plan review ${state.pendingReview.reviewId ?? ""} is still pending for ${state.pendingReview.planSlug}. Wait for the review result before calling plan_resume.`);
			}
			if (!state.activePlan) {
				throw new Error("No active planning workflow exists. Use plan_start first.");
			}

			const agent = (state.activePlan.agentId && deps.registry.findAgent(state.activePlan.agentId))
				?? (state.activePlan.threadId && deps.registry.findAgent(state.activePlan.threadId))
				?? null;
			if (!agent?.threadId) {
				throw new Error("The active plan worker could not be found. Start a new planning workflow with plan_start.");
			}

			const shared = getSharedKnowledgebaseContext(process.cwd(), sessionSlug);
			const prompt = buildPlanResumePrompt({
				feedback: params.feedback,
				commentary: params.commentary,
				planFilePath: state.activePlan.planFilePath,
				sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
			});

			deps.registry.upsertAgent({
				...agent,
				template: "plan",
				allowWrite: true,
				state: "working",
				activityLabel: "starting",
				latestSnippet: `resume: ${truncateForDisplay(prompt, 120)}`,
				latestFinalOutput: null,
				completedAt: null,
				notificationMode: "notify_each",
				returnMode: "wait",
				completionNotified: false,
				messages: agent.messages ?? [],
				historyHydratedAt: agent.historyHydratedAt ?? null,
			});

			if (agent.activeTurnId && agent.state === "working") {
				await deps.client.steerTurn({
					threadId: agent.threadId,
					expectedTurnId: agent.activeTurnId,
					prompt,
				});
				deps.registry.appendUserMessage(agent.id, agent.activeTurnId, prompt);
			} else {
				await deps.client.resumeThread({
					threadId: agent.threadId,
					cwd: agent.cwd,
					model: agent.model,
					approvalPolicy: "never",
					allowWrite: true,
				});
				const turn = await deps.client.startTurn({
					threadId: agent.threadId,
					prompt,
					cwd: agent.cwd,
					model: agent.model,
					effort: (agent.effort as any) ?? "medium",
					approvalPolicy: "never",
					networkAccess: false,
					allowWrite: true,
				});
				deps.registry.markThreadAttached(agent.id, { threadId: agent.threadId, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(agent.threadId, turn.turn.id);
				deps.registry.appendUserMessage(agent.id, turn.turn.id, prompt);
			}

			const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
			const planContent = readPlanFile(state.activePlan.planFilePath);
			const review = await deps.requestPlanReview({
				planContent,
				planFilePath: state.activePlan.planFilePath,
			});
			deps.setPlanState(
				(current) => ({
					...current,
					pendingReview: {
						planSlug: current.activePlan?.planSlug ?? state.activePlan.planSlug,
						reviewId: review.reviewId,
						requestedAt: Date.now(),
					},
				}),
				{ flush: true },
			);

			return {
				content: [{
					type: "text",
					text: [
						`plan_slug: ${state.activePlan.planSlug}`,
						`state: ${finalAgent.state}`,
						`context: ${formatUsageCompact(finalAgent.usage)}`,
						...(formatCompactionSignal(finalAgent.compaction) ? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`] : []),
						`plan_file: ${state.activePlan.planFilePath}`,
						`review_id: ${review.reviewId}`,
						"",
						resolveAgentFinalOutput(finalAgent),
					].join("\n"),
				}],
				details: {
					agent: finalAgent,
					planSlug: state.activePlan.planSlug,
					planFilePath: state.activePlan.planFilePath,
					reviewId: review.reviewId,
				},
			};
		},
	});
}
