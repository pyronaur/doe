import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { truncateForDisplay } from "../codex/client.ts";
import { formatUsageCompact } from "../context-usage.ts";
import {
	deletePlanFileIfEmpty,
	ensurePlanFile,
	formatPlanReuseError,
	getSharedKnowledgebaseContext,
	preparePlanFile,
	readPlanTemplateDefaults,
	renderPlanPrompt,
} from "../plan/flow.ts";
import { formatContextStatusLines } from "./context-status.ts";
import {
	formatPlanProgressSummary,
	type PlanWorkflowToolDeps,
} from "./plan-workflow.ts";
import { renderToolResultText } from "./tool-render.ts";
import { recordStartedTurn } from "./turn-start.ts";
type PlanStartToolDeps = PlanWorkflowToolDeps;

interface PlanStartWorkflowInput {
	deps: PlanStartToolDeps;
	params: any;
	onUpdate?: ((update: any) => void) | undefined;
}

interface PlanStartResultInput {
	context: ReturnType<typeof buildPlanStartContext>;
	seatName: string;
	sessionSlug: string;
	agent: any;
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
	recordStartedTurn(deps.registry, {
		agentId: context.agentId,
		threadId: thread.thread.id,
		turnId: turn.turn.id,
		prompt: context.prompt,
	});
}

function buildPlanStartResult(input: PlanStartResultInput) {
	const { context, seatName, sessionSlug, agent } = input;
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${seatName}`,
				`agent_id: ${context.agentId}`,
				`thread_id: ${agent?.threadId ?? "pending"}`,
				`plan_slug: ${context.planFile.planSlug}`,
				"state: drafting",
				`context: ${formatUsageCompact(agent?.usage)}`,
				...formatContextStatusLines(agent?.compaction),
				`plan_file: ${context.planFile.planFilePath}`,
				"",
				...formatPlanProgressSummary({
					happened:
						"Draft turn started and is running in the background. Review will start automatically after the draft completes.",
					agent: agent ?? null,
				}),
			].join("\n"),
		}],
		details: {
			agent: agent ?? null,
			ic: seatName,
			sessionSlug,
			planSlug: context.planFile.planSlug,
			planFilePath: context.planFile.planFilePath,
			reviewStatus: null,
			reviewFeedback: null,
			reviewId: null,
			happened:
				"Draft turn started and is running in the background. Review will start automatically after the draft completes.",
			agentResponseAt: agent?.completedAt ?? null,
			lastAgentMessage: agent?.latestFinalOutput ?? null,
			sharedKnowledgebasePath: context.shared.sharedKnowledgebasePath,
		},
	};
}

async function executePlanStartWorkflow(input: PlanStartWorkflowInput) {
	const { deps, params, onUpdate } = input;
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

	const agent = deps.registry.getAgent(context.agentId) ?? null;
	return buildPlanStartResult({
		context,
		seatName: context.seat.name,
		sessionSlug: context.sessionSlug,
		agent,
	});
}

function createPlanStartTool(deps: PlanStartToolDeps) {
	return {
		...PLAN_START_TOOL_META,
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `plan_start ${args.planSlug ?? ""}`.trim()), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderToolResultText(theme, result, "plan_start");
		},
		async execute(
			...args: [string, any, AbortSignal | undefined, ((update: any) => void) | undefined]
		) {
			const [, params, _signal, onUpdate] = args;
			return executePlanStartWorkflow({ deps, params, onUpdate });
		},
	};
}

export function registerPlanStartTool(pi: ExtensionAPI, deps: PlanStartToolDeps) {
	pi.registerTool(createPlanStartTool(deps));
}
