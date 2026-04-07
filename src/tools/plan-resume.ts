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
import type { DoePlanReviewResult } from "../plan/review.ts";
import type { DoePlanState } from "../plan/session-state.ts";
import { resolveAgentFinalOutput } from "./agent-final-output.ts";
import { formatContextStatusLines } from "./context-status.ts";
import {
	formatPlanReviewSummary,
	formatPlanRevisionNextStep,
	type PlanWorkflowToolDeps,
	setPlanReadyForReview,
	setPlanReviewOutcome,
} from "./plan-workflow.ts";
import { resumeThreadAndStartTurn, steerActiveTurn } from "./thread-turn.ts";
import { renderToolResultText } from "./tool-render.ts";
type PlanResumeToolDeps = PlanWorkflowToolDeps;

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

interface PlanResumeResultInput {
	agent: any;
	sessionSlug: string;
	planSlug: string;
	planFilePath: string;
	review: DoePlanReviewResult;
}

interface PlanResumeRetryInput {
	deps: PlanResumeToolDeps;
	state: DoePlanState["activePlan"];
	sessionSlug: string;
	signal?: AbortSignal | undefined;
}

interface PlanResumeRevisionInput {
	deps: PlanResumeToolDeps;
	params: any;
	state: DoePlanState["activePlan"];
	sessionSlug: string;
	signal?: AbortSignal | undefined;
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

function reviewActivePlan(
	deps: PlanResumeToolDeps,
	state: DoePlanState["activePlan"],
	signal?: AbortSignal,
) {
	return retryPlanReview({
		reviewPlan: deps.reviewPlan,
		state,
		cwd: process.cwd(),
		signal,
	});
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

function buildPlanResumeResult(input: PlanResumeResultInput) {
	const { agent, sessionSlug, planSlug, planFilePath, review } = input;
	const ic = agent.seatName ?? agent.name ?? "unknown";
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${ic}`,
				`plan_slug: ${planSlug}`,
				`state: ${review.status}`,
				`context: ${formatUsageCompact(agent.usage)}`,
				...formatContextStatusLines(agent.compaction),
				`plan_file: ${planFilePath}`,
				`review_status: ${review.status}`,
				...formatPlanReviewSummary(review),
				...formatPlanRevisionNextStep(review),
				"",
				resolveAgentFinalOutput(agent),
				...(review.status === "approved" ? ["", "Plan approved. Workflow cleared."] : []),
			].join("\n"),
		}],
		details: {
			agent,
			ic,
			sessionSlug,
			planSlug,
			planFilePath,
			reviewStatus: review.status,
			reviewFeedback: review.feedback,
		},
	};
}

function resolvePlanResumeAgent(registry: DoeRegistry, state: DoePlanState["activePlan"]) {
	if (!state) { return null; }
	return (state.agentId && registry.findAgent(state.agentId))
		?? (state.threadId && registry.findAgent(state.threadId))
		?? null;
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

async function handlePlanResumeReviewRetry(input: PlanResumeRetryInput) {
	const { deps, state, sessionSlug, signal } = input;
	if (!state) {
		throw new Error("No active planning workflow exists. Use plan_start first.");
	}
	const review = await reviewActivePlan(deps, state, signal);
	setPlanReviewOutcome(
		deps.setPlanState,
		(activePlan) => activePlan.planFilePath === state.planFilePath,
		review,
	);
	const ic = state.ic ?? "unknown";
	const agent = state.agentId ? deps.registry.findAgent(state.agentId) ?? null : null;
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${ic}`,
				`plan_slug: ${state.planSlug}`,
				`state: ${review.status}`,
				`plan_file: ${state.planFilePath}`,
				`review_status: ${review.status}`,
				...formatPlanReviewSummary(review),
				...formatPlanRevisionNextStep(review),
				"",
				"Review retried without revising the plan.",
				...(review.status === "approved" ? ["", "Plan approved. Workflow cleared."] : []),
			].join("\n"),
		}],
		details: {
			agent,
			ic,
			sessionSlug: state.sessionSlug ?? sessionSlug,
			planSlug: state.planSlug,
			planFilePath: state.planFilePath,
			reviewStatus: review.status,
			reviewFeedback: review.feedback,
		},
	};
}

async function handlePlanResumeRevision(input: PlanResumeRevisionInput) {
	const { deps, params, state, sessionSlug, signal } = input;
	if (!state) {
		throw new Error("No active planning workflow exists. Use plan_start first.");
	}
	const agent = resolvePlanResumeAgent(deps.registry, state);
	if (!agent?.threadId) {
		throw new Error(
			"The active plan worker could not be found. Start a new planning workflow with plan_start.",
		);
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
	setPlanReadyForReview(
		deps.setPlanState,
		(activePlan) => activePlan.agentId === agent.id,
	);

	const review = await reviewActivePlan(deps, state, signal);
	setPlanReviewOutcome(
		deps.setPlanState,
		(activePlan) => activePlan.agentId === agent.id,
		review,
	);
	return buildPlanResumeResult({
		agent: finalAgent,
		sessionSlug: state.sessionSlug ?? sessionSlug,
		planSlug: state.planSlug,
		planFilePath: state.planFilePath,
		review,
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

	if (state.activePlan.status === "ready_for_review" && !state.activePlan.reviewFeedback) {
		return handlePlanResumeReviewRetry({
			deps,
			state: state.activePlan,
			sessionSlug,
			signal,
		});
	}

	if (state.activePlan.status !== "needs_revision" || !state.activePlan.reviewFeedback) {
		throw new Error(
			"The active planning workflow does not have captured review feedback to apply yet. If review is still pending, call plan_resume again without commentary to retry review.",
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
