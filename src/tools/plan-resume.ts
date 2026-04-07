import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { truncateForDisplay } from "../codex/client.ts";
import { formatUsageCompact } from "../context-usage.ts";
import {
	buildPlanResumePrompt,
	getSharedKnowledgebaseContext,
	readPlanFile,
	readPlanTemplateDefaults,
} from "../plan/flow.ts";
import { hasPlanReviewJob } from "../plan/review.ts";
import type { DoePlanState } from "../plan/session-state.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { resolveAgentFinalOutput } from "./agent-final-output.ts";
import { formatContextStatusLines } from "./context-status.ts";
import {
	attachPlanReviewOutcomeHandler,
	formatPlanProgressSummary,
	type PlanWorkflowToolDeps,
	setPlanPendingReview,
	setPlanReadyForReview,
} from "./plan-workflow.ts";
import { resumeThreadAndStartTurn, steerActiveTurn } from "./thread-turn.ts";
import { renderToolResultText } from "./tool-render.ts";
type PlanResumeToolDeps = PlanWorkflowToolDeps;

type ActivePlanState = NonNullable<DoePlanState["activePlan"]>;
type PendingReviewState = NonNullable<DoePlanState["pendingReview"]>;

interface PlanResumeWorkflowInput {
	deps: PlanResumeToolDeps;
	params: any;
	signal?: AbortSignal | undefined;
}

interface PlanResumeSeedInput {
	deps: PlanResumeToolDeps;
	agent: any;
	templateDefaults: ReturnType<typeof readPlanTemplateDefaults>;
	prompt: string;
}

interface PlanResumeTurnInput {
	deps: PlanResumeToolDeps;
	agent: any;
	prompt: string;
	templateDefaults: ReturnType<typeof readPlanTemplateDefaults>;
	allowWrite: boolean;
}

interface PlanResumePendingResultInput {
	agent: any | null;
	sessionSlug: string;
	planSlug: string;
	planFilePath: string;
	reviewId: string;
	note: string;
	includeFinalOutput?: boolean;
}

interface PlanResumeRetryInput {
	deps: PlanResumeToolDeps;
	state: ActivePlanState;
	sessionSlug: string;
}

interface PlanResumeRevisionInput {
	deps: PlanResumeToolDeps;
	params: any;
	state: ActivePlanState;
	sessionSlug: string;
	signal?: AbortSignal | undefined;
}

interface PlanResumePendingInput {
	deps: PlanResumeToolDeps;
	state: ActivePlanState;
	pendingReview: PendingReviewState;
	sessionSlug: string;
}

const PLAN_RESUME_TOOL_META = {
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
			description:
				"Director synthesis to guide the IC revision. Do not relay CTO review feedback here - it is injected automatically.",
		})),
	}),
} as const;

function buildPlanResumeResult(input: PlanResumePendingResultInput) {
	const {
		agent,
		sessionSlug,
		planSlug,
		planFilePath,
		reviewId,
		note,
		includeFinalOutput = false,
	} = input;
	const ic = agent?.seatName ?? agent?.name ?? "unknown";
	const lines = [
		`ic: ${ic}`,
		`plan_slug: ${planSlug}`,
		"state: ready_for_review",
		...(agent
			? [
				`context: ${formatUsageCompact(agent.usage)}`,
				...formatContextStatusLines(agent.compaction),
			]
			: []),
		`plan_file: ${planFilePath}`,
		"review_status: pending",
		`review_id: ${reviewId}`,
		"",
		...formatPlanProgressSummary({
			happened: note,
			agent: agent ?? null,
		}),
	];
	if (includeFinalOutput && agent) {
		lines.push("", resolveAgentFinalOutput(agent, "unknown"));
	}
	return {
		content: [{
			type: "text",
			text: lines.join("\n"),
		}],
		details: {
			agent: agent ?? null,
			ic,
			sessionSlug,
			planSlug,
			planFilePath,
			reviewStatus: "pending",
			reviewFeedback: null,
			reviewId,
			happened: note,
			agentResponseAt: agent?.completedAt ?? null,
			lastAgentMessage: resolveAgentFinalOutput(agent, "unknown"),
		},
	};
}

function resolvePlanResumeAgent(registry: DoeRegistry, state: DoePlanState["activePlan"]) {
	if (!state) {
		return null;
	}
	if (state.agentId) {
		return registry.findAgent(state.agentId) ?? null;
	}
	if (state.threadId) {
		return registry.findAgent(state.threadId) ?? null;
	}
	return null;
}

function seedPlanResumeAgent(input: PlanResumeSeedInput) {
	const { deps, agent, templateDefaults, prompt } = input;
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
}

async function runPlanResumeTurn(input: PlanResumeTurnInput) {
	const { deps, agent, prompt, templateDefaults, allowWrite } = input;
	if (
		await steerActiveTurn({
			client: deps.client,
			registry: deps.registry,
			agent,
			prompt,
		})
	) {
		return;
	}

	const resumeInput = {
		prompt,
		allowWrite,
		threadId: agent.threadId,
		agentId: agent.id,
		cwd: agent.cwd,
		model: templateDefaults.model,
		effort: templateDefaults.effort,
		networkAccess: false,
		approvalPolicy: "never" as const,
		client: deps.client,
		registry: deps.registry,
	};
	await resumeThreadAndStartTurn(resumeInput);
}

function startAsyncPlanReview(input: {
	deps: PlanResumeToolDeps;
	state: ActivePlanState;
	sessionSlug: string;
	reviewId?: string;
	requestedAt?: number;
}) {
	const { deps, state, sessionSlug, reviewId, requestedAt } = input;
	const startedAt = requestedAt ?? Date.now();
	const matchActivePlan = (activePlan: ActivePlanState) =>
		activePlan.planSlug === state.planSlug
		&& activePlan.planFilePath === state.planFilePath
		&& (state.agentId ? activePlan.agentId === state.agentId : true);
	const reviewJob = deps.startReviewPlan({
		reviewId,
		planFilePath: state.planFilePath,
		cwd: process.cwd(),
	});
	const matchPendingReview = (pendingReview: PendingReviewState) =>
		pendingReview.reviewId === reviewJob.reviewId
		&& pendingReview.planSlug === state.planSlug
		&& pendingReview.planFilePath === state.planFilePath;
	setPlanPendingReview(
		deps.setPlanState,
		matchActivePlan,
		{
			reviewId: reviewJob.reviewId,
			sessionSlug: state.sessionSlug ?? sessionSlug,
			planSlug: state.planSlug,
			planFilePath: state.planFilePath,
			agentId: state.agentId,
			requestedAt: startedAt,
		},
	);
	attachPlanReviewOutcomeHandler({
		wait: reviewJob.wait,
		reviewId: reviewJob.reviewId,
		setPlanState: deps.setPlanState,
		matchActive: matchActivePlan,
		matchPending: matchPendingReview,
	});
	return reviewJob.reviewId;
}

async function handlePlanResumeReviewRetry(input: PlanResumeRetryInput) {
	const { deps, state, sessionSlug } = input;
	const reviewId = startAsyncPlanReview({
		deps,
		state,
		sessionSlug,
	});
	const agent = state.agentId ? deps.registry.findAgent(state.agentId) ?? null : null;
	return buildPlanResumeResult({
		agent,
		sessionSlug: state.sessionSlug ?? sessionSlug,
		planSlug: state.planSlug,
		planFilePath: state.planFilePath,
		reviewId,
		note: "Review retried without revising the plan.",
	});
}

async function handlePlanResumePendingReview(input: PlanResumePendingInput) {
	const { deps, state, pendingReview, sessionSlug } = input;
	const agent = state.agentId ? deps.registry.findAgent(state.agentId) ?? null : null;
	if (hasPlanReviewJob(pendingReview.reviewId)) {
		return buildPlanResumeResult({
			agent,
			sessionSlug: pendingReview.sessionSlug ?? sessionSlug,
			planSlug: pendingReview.planSlug,
			planFilePath: pendingReview.planFilePath,
			reviewId: pendingReview.reviewId,
			note: "Review is still pending. No new review process was started.",
		});
	}

	const reviewId = startAsyncPlanReview({
		deps,
		state,
		sessionSlug,
		reviewId: pendingReview.reviewId,
		requestedAt: pendingReview.requestedAt,
	});
	return buildPlanResumeResult({
		agent,
		sessionSlug: pendingReview.sessionSlug ?? sessionSlug,
		planSlug: pendingReview.planSlug,
		planFilePath: pendingReview.planFilePath,
		reviewId,
		note: "Review was restored and is pending.",
	});
}

async function handlePlanResumeRevision(input: PlanResumeRevisionInput) {
	const { deps, params, state, sessionSlug, signal } = input;
	const agent = resolvePlanResumeAgent(deps.registry, state);
	if (!agent?.threadId) {
		throw new Error(
			"The active plan worker could not be found. Start a new planning workflow with plan_start.",
		);
	}
	if (!state.reviewFeedback) {
		throw new Error("No captured review feedback exists yet for this plan.");
	}

	const shared = getSharedKnowledgebaseContext(process.cwd(), sessionSlug);
	const templateDefaults = readPlanTemplateDefaults(deps.templatesDir);
	const prompt = buildPlanResumePrompt({
		reviewFeedback: state.reviewFeedback,
		commentary: params.commentary,
		planFilePath: state.planFilePath,
		sharedKnowledgebasePath: shared.sharedKnowledgebasePath,
	});

	seedPlanResumeAgent({
		deps,
		agent,
		templateDefaults,
		prompt,
	});
	await runPlanResumeTurn({
		deps,
		agent,
		prompt,
		templateDefaults,
		allowWrite: true,
	});

	const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
	readPlanFile(state.planFilePath);
	const matchActivePlan = (activePlan: ActivePlanState) =>
		activePlan.agentId === agent.id
		&& activePlan.planSlug === state.planSlug
		&& activePlan.planFilePath === state.planFilePath;
	setPlanReadyForReview(deps.setPlanState, matchActivePlan);
	const reviewId = startAsyncPlanReview({
		deps,
		state,
		sessionSlug,
	});
	return buildPlanResumeResult({
		agent: finalAgent,
		sessionSlug: state.sessionSlug ?? sessionSlug,
		planSlug: state.planSlug,
		planFilePath: state.planFilePath,
		reviewId,
		note: "Revision complete. Review started in background.",
		includeFinalOutput: true,
	});
}

async function executePlanResumeWorkflow(input: PlanResumeWorkflowInput) {
	const { deps, params, signal } = input;
	const sessionSlug = deps.getSessionSlug();
	if (!sessionSlug) {
		throw new Error("No canonical session slug is set. Call session_set before plan_resume.");
	}

	const state = deps.getPlanState();
	if (!state.activePlan) {
		throw new Error("No active planning workflow exists. Use plan_start first.");
	}
	if (state.activePlan.sessionSlug && state.activePlan.sessionSlug !== sessionSlug) {
		throw new Error(
			`The active planning workflow is bound to session ${state.activePlan.sessionSlug}. Call session_set for that session before plan_resume.`,
		);
	}
	if (
		state.pendingReview?.sessionSlug
		&& state.pendingReview.sessionSlug !== sessionSlug
	) {
		throw new Error(
			`The pending plan review is bound to session ${state.pendingReview.sessionSlug}. Call session_set for that session before plan_resume.`,
		);
	}

	if (state.pendingReview) {
		return handlePlanResumePendingReview({
			deps,
			state: state.activePlan,
			pendingReview: state.pendingReview,
			sessionSlug,
		});
	}

	if (state.activePlan.status === "ready_for_review" && !state.activePlan.reviewFeedback) {
		return handlePlanResumeReviewRetry({
			deps,
			state: state.activePlan,
			sessionSlug,
		});
	}

	if (state.activePlan.status !== "needs_revision" || !state.activePlan.reviewFeedback) {
		throw new Error(
			"The active planning workflow does not have captured review feedback to apply yet. If review is pending, call plan_resume again without commentary.",
		);
	}

	return handlePlanResumeRevision({
		deps,
		params,
		state: state.activePlan,
		sessionSlug,
		signal,
	});
}

function createPlanResumeTool(deps: PlanResumeToolDeps) {
	return {
		...PLAN_RESUME_TOOL_META,
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "plan_resume"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderToolResultText(theme, result, "plan_resume");
		},
		async execute(...args: [string, any, AbortSignal | undefined]) {
			const [, params, signal] = args;
			return executePlanResumeWorkflow({ deps, params, signal });
		},
	};
}

export function registerPlanResumeTool(pi: ExtensionAPI, deps: PlanResumeToolDeps) {
	pi.registerTool(createPlanResumeTool(deps));
}
