import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { truncateForDisplay } from "../codex/client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import type { DoePlanState } from "../plan/session-state.js";
import {
	ensurePlanFile,
	formatPlanReviewCommand,
	formatPlanReuseError,
	getSharedKnowledgebaseContext,
	preparePlanFile,
	readPlanFile,
	renderPlanPrompt,
} from "../plan/flow.js";
import type { DoeRegistry } from "../roster/registry.js";

interface PlanStartToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
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

export function registerPlanStartTool(pi: ExtensionAPI, deps: PlanStartToolDeps) {
	pi.registerTool({
		name: "plan_start",
		label: "Plan Start",
		description: "Start a planning workflow on a specific IC seat in the current DoE session.",
		promptSnippet: "Start a planning workflow on a specific IC seat in the current DoE session.",
		promptGuidelines: [
			"Pass one concise planSlug for this plan.",
			"Pass the planning IC explicitly.",
			"Use this to draft a new plan; use plan_resume to revise the same plan file later.",
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
			ensurePlanFile(planFile.planFilePath);

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
				model: "gpt-5.4",
				effort: "medium",
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
						planSlug: planFile.planSlug,
						planFilePath: planFile.planFilePath,
						ic: seat.name,
						agentId,
						threadId: null,
						startedAt,
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
					model: "gpt-5.4",
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
					model: "gpt-5.4",
					effort: "medium",
					approvalPolicy: "never",
					networkAccess: false,
					allowWrite: true,
				});
				deps.registry.markThreadAttached(agentId, { threadId: thread.thread.id, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(thread.thread.id, turn.turn.id);
				deps.registry.appendUserMessage(agentId, turn.turn.id, prompt);
			} catch (error) {
				deps.registry.markAgentError(agentId, error instanceof Error ? error.message : String(error));
				deps.setPlanState(
					(current) => ({
						...current,
						activePlan: null,
					}),
					{ flush: true },
				);
				throw error;
			}

			const finalAgent = await deps.registry.waitForAgent(agentId, signal);
			readPlanFile(planFile.planFilePath);
			const nextStep = formatPlanReviewCommand(planFile.planFilePath);

			return {
				content: [{
					type: "text",
					text: [
						`ic: ${seat.name}`,
						`plan_slug: ${planFile.planSlug}`,
						`state: ${finalAgent.state}`,
						`context: ${formatUsageCompact(finalAgent.usage)}`,
						...(formatCompactionSignal(finalAgent.compaction) ? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`] : []),
						`plan_file: ${planFile.planFilePath}`,
						`next_step: ${nextStep}`,
						"",
						resolveAgentFinalOutput(finalAgent),
					].join("\n"),
				}],
				details: {
					agent: finalAgent,
					ic: seat.name,
					planSlug: planFile.planSlug,
					planFilePath: planFile.planFilePath,
					nextStep,
					sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
				},
			};
		},
	});
}
