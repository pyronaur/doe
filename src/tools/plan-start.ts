import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { summarizeErrorText, truncateForDisplay } from "../codex/client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import type { DoePlanState } from "../plan/session-state.js";
import {
	deletePlanFileIfEmpty,
	ensurePlanFile,
	formatPlanReuseError,
	getSharedKnowledgebaseContext,
	preparePlanFile,
	readPlanFile,
	readPlanTemplateDefaults,
	renderPlanPrompt,
} from "../plan/flow.js";
import type { DoePlanReviewResult } from "../plan/review.js";
import type { DoeRegistry } from "../roster/registry.js";

interface PlanStartToolDeps {
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

function formatPlanStartNextStep(review: DoePlanReviewResult): string[] {
	if (review.status !== "needs_revision") return [];
	return [
		"",
		"<next_step>",
		"Review feedback is stored automatically. Use plan_resume with Director commentary only.",
		"</next_step>",
	];
}

export function registerPlanStartTool(pi: ExtensionAPI, deps: PlanStartToolDeps) {
	pi.registerTool({
		name: "plan_start",
		label: "Plan Start",
		description: "Start a planning workflow on a specific IC seat in the current DoE session.",
		promptSnippet: "Start a planning workflow on a specific IC seat in the current DoE session.",
		promptGuidelines: [
			"Pass one concise planSlug for this plan.",
			"Pass the planning IC explicitly.",
			"Use this to draft a new plan; DOE will submit the plan file to Plannotator CLI automatically after the draft completes.",
		],
		parameters: Type.Object({
			ic: Type.String(),
			planSlug: Type.String(),
			prompt: Type.String(),
			allowExisting: Type.Optional(Type.Boolean()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `plan_start ${(args as any).planSlug ?? ""}`.trim()), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "plan_start"), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const sessionSlug = deps.getSessionSlug();
			if (!sessionSlug) {
				throw new Error("No canonical session slug is set. Call session_set before plan_start.");
			}

			const state = deps.getPlanState();
			if (state.activePlan) {
				throw new Error(`A planning workflow is already active for ${state.activePlan.planSlug}. Use plan_resume to continue it or plan_stop to abandon it before starting a new plan.`);
			}

			const repoRoot = process.cwd();
			const shared = getSharedKnowledgebaseContext(repoRoot, sessionSlug);
			const planFile = preparePlanFile({
				repoRoot,
				sessionSlug,
				planSlug: params.planSlug,
				allowExisting: params.allowExisting,
			});
			if (planFile.requiresAllowExisting) {
				throw new Error(formatPlanReuseError(planFile));
			}
			const ensuredPlanFile = ensurePlanFile(planFile.planFilePath);
			const templateDefaults = readPlanTemplateDefaults(deps.templatesDir);

			const prompt = renderPlanPrompt({
				templatesDir: deps.templatesDir,
				task: params.prompt,
				planFilePath: planFile.planFilePath,
				sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
			});

			const agentId = randomUUID();
			const startedAt = Date.now();
			const seat = deps.registry.assignSeat({
				agentId,
				ic: params.ic,
			});

			deps.registry.upsertAgent({
				id: agentId,
				name: seat.name,
				cwd: repoRoot,
				model: templateDefaults.model,
				effort: templateDefaults.effort,
				template: "plan",
				allowWrite: true,
				threadId: null,
				activeTurnId: null,
				state: "working",
				activityLabel: "starting",
				latestSnippet: `queued: ${truncateForDisplay(prompt, 120)}`,
				latestFinalOutput: null,
				lastError: null,
				usage: null,
				compaction: null,
				startedAt,
				completedAt: null,
				parentBatchId: null,
				notificationMode: "notify_each",
				returnMode: "wait",
				completionNotified: false,
				recovered: false,
				seatName: seat.name,
				seatRole: seat.role,
				finishNote: null,
				reuseSummary: null,
				messages: [],
				historyHydratedAt: null,
			});

			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: {
						sessionSlug,
						planSlug: planFile.planSlug,
						planFilePath: planFile.planFilePath,
						ic: seat.name,
						agentId,
						threadId: null,
						status: "drafting",
						reviewFeedback: null,
					},
				}),
				{ flush: true },
			);

			onUpdate?.({
				content: [{ type: "text", text: `Launching plan worker for ${planFile.planSlug}` }],
				details: { planSlug: planFile.planSlug, planFilePath: planFile.planFilePath },
			});

			try {
				const thread = await deps.client.startThread({
					model: templateDefaults.model,
					cwd: repoRoot,
					approvalPolicy: "never",
					networkAccess: false,
					allowWrite: true,
				});
				deps.registry.markThreadAttached(agentId, { threadId: thread.thread.id });
				deps.setPlanState(
					(current) => ({
						...current,
						activePlan: current.activePlan
							? {
									...current.activePlan,
									ic: current.activePlan.ic ?? seat.name,
									threadId: thread.thread.id,
								}
							: current.activePlan,
					}),
					{ flush: true },
				);

				const turn = await deps.client.startTurn({
					threadId: thread.thread.id,
					prompt,
					cwd: repoRoot,
					model: templateDefaults.model,
					effort: templateDefaults.effort,
					approvalPolicy: "never",
					networkAccess: false,
					allowWrite: true,
				});
				deps.registry.markThreadAttached(agentId, { threadId: thread.thread.id, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(thread.thread.id, turn.turn.id);
				deps.registry.appendUserMessage(agentId, turn.turn.id, prompt);
			} catch (error) {
				deps.registry.markAgentError(agentId, summarizeErrorText(error));
				deps.setPlanState(
					(current) => ({
						...current,
						activePlan: null,
					}),
					{ flush: true },
				);
				if (ensuredPlanFile.created) {
					deletePlanFileIfEmpty(ensuredPlanFile.path);
				}
				throw error;
			}

			const finalAgent = await deps.registry.waitForAgent(agentId, signal);
			readPlanFile(planFile.planFilePath);
			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: current.activePlan?.agentId === agentId
						? {
								...current.activePlan,
								status: "ready_for_review",
								reviewFeedback: null,
							}
						: current.activePlan,
				}),
				{ flush: true },
			);
			onUpdate?.({
				content: [{ type: "text", text: `Draft complete for ${planFile.planSlug}. Waiting for Plannotator review.` }],
				details: { planSlug: planFile.planSlug, planFilePath: planFile.planFilePath },
			});
			let review: DoePlanReviewResult;
			try {
				review = await deps.reviewPlan({
					planFilePath: planFile.planFilePath,
					cwd: repoRoot,
					signal,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`${reason}\nUse plan_resume to retry review for the same plan workflow.`);
			}
			deps.setPlanState(
				(current) => ({
					...current,
					activePlan: current.activePlan?.agentId === agentId
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

			return {
				content: [{
					type: "text",
					text: [
						`ic: ${seat.name}`,
						`plan_slug: ${planFile.planSlug}`,
						`state: ${review.status}`,
						`context: ${formatUsageCompact(finalAgent.usage)}`,
						...(formatCompactionSignal(finalAgent.compaction) ? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`] : []),
						`plan_file: ${planFile.planFilePath}`,
						`review_status: ${review.status}`,
						...formatPlanReviewSummary(review),
						...formatPlanStartNextStep(review),
						"",
						resolveAgentFinalOutput(finalAgent),
						...(review.status === "approved" ? ["", "Plan approved. Workflow cleared."] : []),
					].join("\n"),
				}],
				details: {
					agent: finalAgent,
					ic: seat.name,
					sessionSlug,
					planSlug: planFile.planSlug,
					planFilePath: planFile.planFilePath,
					reviewStatus: review.status,
					reviewFeedback: review.feedback,
					sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
				},
			};
		},
	});
}
