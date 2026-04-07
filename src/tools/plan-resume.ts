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
	readPlanTemplateDefaults,
} from "../plan/flow.js";
import type { DoePlanReviewResult } from "../plan/review.js";
import type { DoePlanState } from "../plan/session-state.js";
import type { DoeRegistry } from "../roster/registry.js";

interface PlanResumeToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	reviewPlan: (input: { planFilePath: string; cwd: string; signal?: AbortSignal }) => Promise<DoePlanReviewResult>;
	getSessionSlug: () => string | null;
	getPlanState: () => DoePlanState;
	setPlanState: (updater: (state: DoePlanState) => DoePlanState, options?: { flush?: boolean }) => DoePlanState;
}

function resolveAgentFinalOutput(agent: any): string {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) => message?.role === "agent" && typeof message?.text === "string" && message.text.trim().length > 0)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? "Completed";
}

function formatPlanReviewSummary(review: DoePlanReviewResult): string[] {
	if (!review.feedback) return [];
	return ["", "<review_feedback>", review.feedback, "</review_feedback>"];
}

function formatPlanResumeNextStep(review: DoePlanReviewResult): string[] {
	if (review.status !== "needs_revision") return [];
	return [
		"",
		"<next_step>",
		"Review feedback is stored automatically. Use plan_resume with Director commentary only.",
		"</next_step>",
	];
}

async function retryPlanReview(input: {
	reviewPlan: PlanResumeToolDeps["reviewPlan"];
	state: DoePlanState["activePlan"];
	cwd: string;
	signal?: AbortSignal;
}) {
	if (!input.state) {
		throw new Error("No active planning workflow exists. Use plan_start first.");
	}
	try {
		return await input.reviewPlan({
			planFilePath: input.state.planFilePath,
			cwd: input.cwd,
			signal: input.signal,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${reason}\nUse plan_resume again to retry review for the same plan workflow.`);
	}
}

export function registerPlanResumeTool(pi: ExtensionAPI, deps: PlanResumeToolDeps) {
	pi.registerTool({
		name: "plan_resume",
		label: "Plan Resume",
		description: "Continue the current plan on the same IC seat and plan file.",
		promptSnippet: "Continue the current plan on the same IC seat and plan file.",
		promptGuidelines: [
			"Use this only when an active planning workflow already exists.",
			"When the workflow is ready_for_review, retry the review only and do not revise the plan.",
			"When the workflow needs_revision, revise the same plan file and then re-run review.",
			"DOE automatically includes the captured review feedback for the active plan.",
			"Pass only the Director commentary needed for the revision.",
		],
		parameters: Type.Object({
			commentary: Type.Optional(Type.String({
				description: "Director synthesis to guide the IC revision. Do not relay CTO review feedback here - it is injected automatically.",
			})),
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
			if (!state.activePlan) {
				throw new Error("No active planning workflow exists. Use plan_start first.");
			}
			if (state.activePlan.sessionSlug && state.activePlan.sessionSlug !== sessionSlug) {
				throw new Error(`The active planning workflow is bound to session ${state.activePlan.sessionSlug}. Call session_set for that session before plan_resume.`);
			}
			if (state.activePlan.status === "ready_for_review" && !state.activePlan.reviewFeedback) {
				const review = await retryPlanReview({
					reviewPlan: deps.reviewPlan,
					state: state.activePlan,
					cwd: process.cwd(),
					signal,
				});
				deps.setPlanState(
					(current) => ({
						...current,
						activePlan: current.activePlan?.planFilePath === state.activePlan?.planFilePath
							? review.status === "approved"
								? null
								: {
										...current.activePlan,
										status: "needs_revision",
										reviewFeedback: review.feedback,
									}
							: current.activePlan,
					}),
					{ flush: true },
				);
				const ic = state.activePlan.ic ?? "unknown";
				return {
					content: [{
						type: "text",
						text: [
							`ic: ${ic}`,
							`plan_slug: ${state.activePlan.planSlug}`,
							`state: ${review.status}`,
							`plan_file: ${state.activePlan.planFilePath}`,
							`review_status: ${review.status}`,
							...formatPlanReviewSummary(review),
							...formatPlanResumeNextStep(review),
							"",
							"Review retried without revising the plan.",
							...(review.status === "approved" ? ["", "Plan approved. Workflow cleared."] : []),
					].join("\n"),
					}],
					details: {
						agent: state.activePlan.agentId ? deps.registry.findAgent(state.activePlan.agentId) ?? null : null,
						ic,
						sessionSlug: state.activePlan.sessionSlug ?? sessionSlug,
						planSlug: state.activePlan.planSlug,
						planFilePath: state.activePlan.planFilePath,
						reviewStatus: review.status,
						reviewFeedback: review.feedback,
					},
				};
			}
			if (state.activePlan.status !== "needs_revision" || !state.activePlan.reviewFeedback) {
				throw new Error("The active planning workflow does not have captured review feedback to apply yet. If review is still pending, call plan_resume again without commentary to retry review.");
			}

			const agent = (state.activePlan.agentId && deps.registry.findAgent(state.activePlan.agentId))
				?? (state.activePlan.threadId && deps.registry.findAgent(state.activePlan.threadId))
				?? null;
			if (!agent?.threadId) {
				throw new Error("The active plan worker could not be found. Start a new planning workflow with plan_start.");
			}

			const shared = getSharedKnowledgebaseContext(process.cwd(), sessionSlug);
			const templateDefaults = readPlanTemplateDefaults(deps.templatesDir);
			const prompt = buildPlanResumePrompt({
				reviewFeedback: state.activePlan.reviewFeedback,
				commentary: params.commentary,
				planFilePath: state.activePlan.planFilePath,
				sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
			});

			deps.registry.upsertAgent({
				...agent,
				model: templateDefaults.model,
				effort: templateDefaults.effort,
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
					model: templateDefaults.model,
					approvalPolicy: "never",
					allowWrite: true,
				});
				const turn = await deps.client.startTurn({
					threadId: agent.threadId,
					prompt,
					cwd: agent.cwd,
					model: templateDefaults.model,
					effort: templateDefaults.effort,
					approvalPolicy: "never",
					networkAccess: false,
					allowWrite: true,
				});
				deps.registry.markThreadAttached(agent.id, { threadId: agent.threadId, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(agent.threadId, turn.turn.id);
				deps.registry.appendUserMessage(agent.id, turn.turn.id, prompt);
			}

			const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
			readPlanFile(state.activePlan.planFilePath);
			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: current.activePlan?.agentId === agent.id
						? {
								...current.activePlan,
								status: "ready_for_review",
								reviewFeedback: null,
							}
						: current.activePlan,
				}),
				{ flush: true },
			);
			const review = await retryPlanReview({
				reviewPlan: deps.reviewPlan,
				state: state.activePlan,
				cwd: process.cwd(),
				signal,
			});
			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: current.activePlan?.agentId === agent.id
						? review.status === "approved"
							? null
							: {
									...current.activePlan,
									status: "needs_revision",
									reviewFeedback: review.feedback,
								}
						: current.activePlan,
				}),
				{ flush: true },
			);
			const ic = state.activePlan.ic ?? agent.seatName ?? agent.name;

			return {
				content: [{
					type: "text",
					text: [
						`ic: ${ic}`,
						`plan_slug: ${state.activePlan.planSlug}`,
						`state: ${review.status}`,
						`context: ${formatUsageCompact(finalAgent.usage)}`,
						...(formatCompactionSignal(finalAgent.compaction) ? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`] : []),
						`plan_file: ${state.activePlan.planFilePath}`,
						`review_status: ${review.status}`,
						...formatPlanReviewSummary(review),
						...formatPlanResumeNextStep(review),
						"",
						resolveAgentFinalOutput(finalAgent),
						...(review.status === "approved" ? ["", "Plan approved. Workflow cleared."] : []),
					].join("\n"),
				}],
				details: {
					agent: finalAgent,
					ic,
					sessionSlug: state.activePlan.sessionSlug ?? sessionSlug,
					planSlug: state.activePlan.planSlug,
					planFilePath: state.activePlan.planFilePath,
					reviewStatus: review.status,
					reviewFeedback: review.feedback,
				},
			};
		},
	});
}
