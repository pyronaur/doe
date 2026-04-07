import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import { truncateForDisplay } from "../codex/client.ts";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.ts";
import {
	deletePlanFileIfEmpty,
	ensurePlanFile,
	formatPlanReuseError,
	getSharedKnowledgebaseContext,
	preparePlanFile,
	readPlanFile,
	readPlanTemplateDefaults,
	renderPlanPrompt,
} from "../plan/flow.ts";
import type { DoePlanReviewResult } from "../plan/review.ts";
import type { DoePlanState } from "../plan/session-state.ts";
import type { DoeRegistry } from "../roster/registry.ts";

interface PlanStartToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	reviewPlan: (
		input: { planFilePath: string; cwd: string; signal?: AbortSignal },
	) => Promise<DoePlanReviewResult>;
	getSessionSlug: () => string | null;
	getPlanState: () => DoePlanState;
	setPlanState: (
		updater: (state: DoePlanState) => DoePlanState,
		options?: { flush?: boolean },
	) => DoePlanState;
}

interface PlanStartWorkflowInput {
	deps: PlanStartToolDeps;
	params: any;
	signal?: AbortSignal;
	onUpdate?: ((update: any) => void) | undefined;
}

interface PlanStartFinishInput {
	deps: PlanStartToolDeps;
	context: ReturnType<typeof buildPlanStartContext>;
	agentId: string;
	signal?: AbortSignal | undefined;
	onUpdate?: ((update: any) => void) | undefined;
}

interface PlanStartResultInput {
	context: ReturnType<typeof buildPlanStartContext>;
	seatName: string;
	sessionSlug: string;
	finalAgent: any;
	review: DoePlanReviewResult;
}

function resolveAgentFinalOutput(agent: any): string {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) =>
			message?.role === "agent" && typeof message?.text === "string"
			&& message.text.trim().length > 0
		)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? "Completed";
}

function formatPlanReviewSummary(review: DoePlanReviewResult): string[] {
	if (!review.feedback) {return [];}
	return ["", "<review_feedback>", review.feedback, "</review_feedback>"];
}

function formatPlanStartNextStep(review: DoePlanReviewResult): string[] {
	if (review.status !== "needs_revision") {return [];}
	return [
		"",
		"<next_step>",
		"Review feedback is stored automatically. Use plan_resume with Director commentary only.",
		"</next_step>",
	];
}

const PLAN_START_TOOL_META = {
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
} as const;

function buildPlanStartContext(deps: PlanStartToolDeps, params: any) {
	const sessionSlug = deps.getSessionSlug();
	if (!sessionSlug) {
		throw new Error("No canonical session slug is set. Call session_set before plan_start.");
	}

	const state = deps.getPlanState();
	if (state.activePlan) {
		throw new Error(
			`A planning workflow is already active for ${state.activePlan.planSlug}. Use plan_resume to continue it or plan_stop to abandon it before starting a new plan.`,
		);
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
	const seat = deps.registry.assignSeat({
		agentId,
		ic: params.ic,
	});

	return {
		agentId,
		ensuredPlanFile,
		prompt,
		planFile,
		repoRoot,
		seat,
		sessionSlug,
		shared,
		templateDefaults,
	};
}

function seedPlanStartAgent(
	deps: PlanStartToolDeps,
	context: ReturnType<typeof buildPlanStartContext>,
) {
	deps.registry.upsertAgent({
		id: context.agentId,
		name: context.seat.name,
		cwd: context.repoRoot,
		model: context.templateDefaults.model,
		effort: context.templateDefaults.effort,
		template: "plan",
		allowWrite: true,
		threadId: null,
		activeTurnId: null,
		state: "working",
		activityLabel: "starting",
		latestSnippet: `queued: ${truncateForDisplay(context.prompt, 120)}`,
		latestFinalOutput: null,
		lastError: null,
		usage: null,
		compaction: null,
		startedAt: Date.now(),
		completedAt: null,
		parentBatchId: null,
		notificationMode: "notify_each",
		returnMode: "wait",
		completionNotified: false,
		recovered: false,
		seatName: context.seat.name,
		seatRole: context.seat.role,
		finishNote: null,
		reuseSummary: null,
		messages: [],
		historyHydratedAt: null,
	});

	deps.setPlanState(
		(current) => ({
			...current,
			activePlan: {
				sessionSlug: context.sessionSlug,
				planSlug: context.planFile.planSlug,
				planFilePath: context.planFile.planFilePath,
				ic: context.seat.name,
				agentId: context.agentId,
				threadId: null,
				status: "drafting",
				reviewFeedback: null,
			},
		}),
		{ flush: true },
	);
}

async function startPlanDraft(
	deps: PlanStartToolDeps,
	context: ReturnType<typeof buildPlanStartContext>,
) {
	const thread = await deps.client.startThread({
		model: context.templateDefaults.model,
		cwd: context.repoRoot,
		approvalPolicy: "never",
		networkAccess: false,
		allowWrite: true,
	});
	deps.registry.markThreadAttached(context.agentId, { threadId: thread.thread.id });
	deps.setPlanState(
		(current) => ({
			...current,
			activePlan: current.activePlan
				? {
					...current.activePlan,
					ic: current.activePlan.ic ?? context.seat.name,
					threadId: thread.thread.id,
				}
				: current.activePlan,
		}),
		{ flush: true },
	);

	const turn = await deps.client.startTurn({
		threadId: thread.thread.id,
		prompt: context.prompt,
		cwd: context.repoRoot,
		model: context.templateDefaults.model,
		effort: context.templateDefaults.effort,
		approvalPolicy: "never",
		networkAccess: false,
		allowWrite: true,
	});
	deps.registry.markThreadAttached(context.agentId, {
		threadId: thread.thread.id,
		activeTurnId: turn.turn.id,
	});
	deps.registry.markTurnStarted(thread.thread.id, turn.turn.id);
	deps.registry.appendUserMessage(context.agentId, turn.turn.id, context.prompt);
}

async function finishPlanStart(input: PlanStartFinishInput) {
	const { deps, context, agentId, signal, onUpdate } = input;
	const finalAgent = await deps.registry.waitForAgent(agentId, signal);
	readPlanFile(context.planFile.planFilePath);
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
		content: [{
			type: "text",
			text: `Draft complete for ${context.planFile.planSlug}. Waiting for Plannotator review.`,
		}],
		details: { planSlug: context.planFile.planSlug, planFilePath: context.planFile.planFilePath },
	});

	let review: DoePlanReviewResult;
	try {
		review = await deps.reviewPlan({
			planFilePath: context.planFile.planFilePath,
			cwd: context.repoRoot,
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

	return { finalAgent, review };
}

function buildPlanStartResult(input: PlanStartResultInput) {
	const { context, seatName, sessionSlug, finalAgent, review } = input;
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${seatName}`,
				`plan_slug: ${context.planFile.planSlug}`,
				`state: ${review.status}`,
				`context: ${formatUsageCompact(finalAgent.usage)}`,
				...(formatCompactionSignal(finalAgent.compaction)
					? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`]
					: []),
				`plan_file: ${context.planFile.planFilePath}`,
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
			ic: seatName,
			sessionSlug,
			planSlug: context.planFile.planSlug,
			planFilePath: context.planFile.planFilePath,
			reviewStatus: review.status,
			reviewFeedback: review.feedback,
			sharedKnowledgebasePath: context.shared.sharedKnowledgebasePath,
		},
	};
}

async function executePlanStartWorkflow(input: PlanStartWorkflowInput) {
	const { deps, params, signal, onUpdate } = input;
	const context = buildPlanStartContext(deps, params);
	seedPlanStartAgent(deps, context);

	onUpdate?.({
		content: [{ type: "text", text: `Launching plan worker for ${context.planFile.planSlug}` }],
		details: {
			planSlug: context.planFile.planSlug,
			planFilePath: context.planFile.planFilePath,
		},
	});

	try {
		await startPlanDraft(deps, context);
	} catch (error) {
		deps.registry.markAgentError(
			context.agentId,
			error instanceof Error ? error.message : String(error),
		);
		deps.setPlanState(
			(current) => ({
				...current,
				activePlan: null,
			}),
			{ flush: true },
		);
		if (context.ensuredPlanFile.created) {
			deletePlanFileIfEmpty(context.ensuredPlanFile.path);
		}
		throw error;
	}

	const { finalAgent, review } = await finishPlanStart({
		deps,
		context,
		agentId: context.agentId,
		signal,
		onUpdate,
	});
	return buildPlanStartResult({
		context,
		seatName: context.seat.name,
		sessionSlug: context.sessionSlug,
		finalAgent,
		review,
	});
}

function createPlanStartTool(deps: PlanStartToolDeps) {
	return {
		...PLAN_START_TOOL_META,
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `plan_start ${args.planSlug ?? ""}`.trim()), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "plan_start"), 0, 0);
		},
		async execute(
			...args: [string, any, AbortSignal | undefined, ((update: any) => void) | undefined]
		) {
			const [, params, signal, onUpdate] = args;
			return executePlanStartWorkflow({ deps, params, signal, onUpdate });
		},
	};
}

export function registerPlanStartTool(pi: ExtensionAPI, deps: PlanStartToolDeps) {
	pi.registerTool(createPlanStartTool(deps));
}
