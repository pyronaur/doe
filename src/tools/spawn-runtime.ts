import { randomUUID } from "node:crypto";
import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from "../codex/client.ts";
import { extractLastCompletedAgentMessage, truncateForDisplay } from "../codex/client.ts";
import { readOptionalModelId, validateModelId } from "../codex/model-selection.ts";
import { getSharedKnowledgebaseContext, type SharedKnowledgebaseContext } from "../plan/flow.ts";
import type { ICRole, NotificationMode, SeatRole } from "../roster/types.ts";
import { isRecord } from "../utils/guards.ts";
import { cancelAgentRun } from "./cancel-agent-run.ts";
import { startToolProgressUpdates } from "./progress-updates.ts";
import { formatSpawnAgentResult, formatSpawnBatchResults } from "./spawn-result.ts";
import type {
	SpawnBatchContext,
	SpawnExecuteArgs,
	SpawnExecutionInput,
} from "./spawn-runtime-types.ts";
import { inferName, normalizeSpawnSeatIntent } from "./spawn-seat-intent.ts";
import type { SpawnExecuteContext, SpawnToolDeps } from "./spawn.ts";
import { buildTemplatePrompt } from "./template-prompt.ts";
import { recordStartedTurn } from "./turn-start.ts";
function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return value === "never" || value === "on-request" || value === "on-failure"
		|| value === "untrusted";
}
function isSandboxMode(value: unknown): value is SandboxMode {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}
function isICRole(value: unknown): value is ICRole {
	return value === "researcher" || value === "senior" || value === "mid";
}
function stripTaskControlKeys(task: unknown) {
	if (!isRecord(task)) {
		return {};
	}
	const { returnMode: _taskReturnMode, notificationMode: _taskNotifyMode, ...rest } = task;
	return rest;
}
function buildTasks(params: any): any[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	if (!params.prompt || typeof params.prompt !== "string") {
		throw new Error("Provide either tasks[] or a single prompt.");
	}
	return [{
		name: params.name ?? inferName(params.prompt),
		ic: params.ic,
		role: params.role,
		prompt: params.prompt,
		cwd: params.cwd,
		model: params.model,
		effort: params.effort,
		template: params.template,
		templateVariables: params.templateVariables,
		approvalPolicy: params.approvalPolicy,
		networkAccess: params.networkAccess,
		allowWrite: params.allowWrite,
		sandbox: params.sandbox,
	}];
}
function buildPrompt(
	task: any,
	templatesDir: string,
	sharedContext: SharedKnowledgebaseContext | null,
) {
	return buildTemplatePrompt({
		template: task.template,
		prompt: task.prompt,
		templatesDir,
		templateVariables: task.templateVariables,
		extraVariables: {
			name: task.name,
			cwd: task.cwd,
		},
		sharedContext,
		unknownTemplateMessage: (templateName, docs) =>
			`Unknown template "${templateName}". Available: ${
				docs.map((entry) => entry.name).join(", ") || "none"
			}`,
	});
}
function normalizeSeatTasks(tasks: any[], registry: any): any[] {
	return tasks.map((task) => {
		const seatIntent = normalizeSpawnSeatIntent(task, (name) => Boolean(registry.findSeat(name)));
		return { ...task, name: seatIntent.taskName, ic: seatIntent.ic };
	});
}
function resolveApprovalPolicy(value: unknown): ApprovalPolicy {
	if (isApprovalPolicy(value)) {
		return value;
	}
	return "never";
}
function resolveReasoningEffort(
	value: unknown,
	defaultEffort: ReasoningEffort | null,
): ReasoningEffort {
	if (isReasoningEffort(value)) {
		return value;
	}
	if (defaultEffort) {
		return defaultEffort;
	}
	return "medium";
}
function resolveRole(value: unknown): ICRole | null {
	if (!isICRole(value)) {
		return null;
	}
	return value;
}
function resolveSandbox(value: unknown): SandboxMode | null {
	if (!isSandboxMode(value)) {
		return null;
	}
	return value;
}
function inferAllowWrite(
	task: { template?: string | null; allowWrite?: boolean },
	templateName: string | null,
): boolean {
	if (typeof task.allowWrite === "boolean") {
		return task.allowWrite;
	}
	return (templateName ?? task.template ?? null) === "implement";
}
function resolveSeatExecutionRole(requestedRole: ICRole | null, seatRole: SeatRole): ICRole {
	if (seatRole !== "contractor") {
		return seatRole;
	}
	if (requestedRole) {
		return requestedRole;
	}
	throw new Error("Contractor assignments require an explicit role.");
}
function createBatchContext(params: any, tasks: any[]): SpawnBatchContext {
	const batchId = tasks.length > 1 ? randomUUID() : null;
	const notificationMode: NotificationMode = batchId ? "wait_all" : "notify_each";
	const returnMode = "wait" as const;
	const batchName = params.batchName
		?? (tasks.length > 1 ? `${tasks.length} delegated tasks` : tasks[0]?.name ?? "delegated task");
	return {
		batchId,
		batchName,
		notificationMode,
		returnMode,
		agentIds: tasks.map(() => randomUUID()),
		promptsByAgentId: {},
	};
}
function registerBatch(registry: any, context: SpawnBatchContext) {
	if (!context.batchId) {
		return;
	}
	registry.createBatch({
		id: context.batchId,
		name: context.batchName,
		agentIds: context.agentIds,
		notificationMode: context.notificationMode,
		returnMode: context.returnMode,
	});
}
function requireSessionSlug(deps: SpawnToolDeps): string {
	const sessionSlug = deps.getSessionSlug?.() ?? null;
	if (!sessionSlug) {
		throw new Error("No canonical session slug is set. Call session_set before codex_spawn.");
	}
	return sessionSlug;
}
function startSpawnProgress(
	deps: SpawnToolDeps,
	context: SpawnBatchContext,
	onUpdate: ((update: any) => void) | undefined,
) {
	return startToolProgressUpdates({
		registry: deps.registry,
		agentIds: context.agentIds,
		onUpdate,
		baseDetails: {
			batchId: context.batchId,
			batchName: context.batchName,
			partial: true,
		},
		onProgressSummary: deps.setWorkingMessage,
		onStop: () => deps.setWorkingMessage?.(),
	});
}
function readTaskContext(input: {
	deps: SpawnToolDeps;
	context: SpawnBatchContext;
	params: any;
	rawTask: any;
	sessionSlug: string;
	index: number;
	resolveSandboxMode: (
		role: ICRole | null | undefined,
		sandbox?: SandboxMode | null,
	) => SandboxMode;
}) {
	const agentId = input.context.agentIds[input.index];
	const cwd = input.rawTask.cwd ?? process.cwd();
	const sharedContext = getSharedKnowledgebaseContext(cwd, input.sessionSlug);
	const promptInfo = buildPrompt(input.rawTask, input.deps.templatesDir, sharedContext);
	input.context.promptsByAgentId[agentId] = promptInfo.prompt;
	const explicitModel = readOptionalModelId(input.rawTask.model, "model");
	const requestedRole = resolveRole(input.rawTask.role);
	const seat = input.deps.registry.assignSeat({
		agentId,
		ic: input.rawTask.ic ?? null,
		role: requestedRole,
		model: explicitModel ?? promptInfo.templateDefaultModel,
	});
	const model = validateModelId(
		explicitModel ?? promptInfo.templateDefaultModel ?? seat.model,
		explicitModel ? "model" : "resolved model",
	);
	const effort = resolveReasoningEffort(input.rawTask.effort, promptInfo.templateDefaultEffort);
	const allowWrite = inferAllowWrite(input.rawTask, promptInfo.templateName);
	const executionRole = resolveSeatExecutionRole(requestedRole, seat.role);
	const sandbox = input.resolveSandboxMode(
		executionRole,
		resolveSandbox(input.rawTask.sandbox) ?? resolveSandbox(input.params.sandbox),
	);
	return {
		agentId,
		seat,
		cwd,
		model,
		effort,
		allowWrite,
		prompt: promptInfo.prompt,
		approvalPolicy: resolveApprovalPolicy(input.rawTask.approvalPolicy),
		networkAccess: input.rawTask.networkAccess === true,
		sandbox,
	};
}
function seedTaskAgent(
	context: SpawnBatchContext,
	task: ReturnType<typeof readTaskContext>,
	deps: SpawnToolDeps,
) {
	const now = Date.now();
	deps.registry.upsertAgent({
		id: task.agentId,
		name: task.seat.name,
		cwd: task.cwd,
		model: task.model,
		effort: task.effort,
		template: null,
		allowWrite: task.allowWrite,
		threadId: null,
		activeTurnId: null,
		state: "working",
		activityLabel: "starting",
		latestSnippet: `queued: ${truncateForDisplay(task.prompt, 120)}`,
		latestFinalOutput: null,
		lastError: null,
		usage: null,
		compaction: null,
		startedAt: now,
		runStartedAt: now,
		completedAt: null,
		parentBatchId: context.batchId,
		notificationMode: context.notificationMode,
		returnMode: context.returnMode,
		completionNotified: false,
		recovered: false,
		seatName: task.seat.name,
		seatRole: task.seat.role,
		finishNote: null,
		reuseSummary: null,
		messages: [],
		historyHydratedAt: null,
	});
}
function buildThreadLaunchOptions(task: {
	cwd: string;
	model: string;
	approvalPolicy: ApprovalPolicy;
	networkAccess: boolean;
	allowWrite: boolean;
	sandbox: SandboxMode;
}) {
	return {
		cwd: task.cwd,
		model: task.model,
		approvalPolicy: task.approvalPolicy,
		networkAccess: task.networkAccess,
		allowWrite: task.allowWrite,
		sandbox: task.sandbox,
	};
}
async function launchTask(deps: SpawnToolDeps, task: ReturnType<typeof readTaskContext>) {
	try {
		const thread = await deps.client.startThread(buildThreadLaunchOptions(task));
		deps.registry.markThreadAttached(task.agentId, { threadId: thread.thread.id });
		const turn = await deps.client.startTurn({
			threadId: thread.thread.id,
			prompt: task.prompt,
			effort: task.effort,
			...buildThreadLaunchOptions(task),
		});
		recordStartedTurn(deps.registry, {
			agentId: task.agentId,
			threadId: thread.thread.id,
			turnId: turn.turn.id,
			prompt: task.prompt,
		});
	} catch (error) {
		deps.registry.markAgentError(task.agentId,
			error instanceof Error ? error.message : String(error));
		throw error;
	}
}
async function runTasks(input: {
	execution: SpawnExecutionInput;
	context: SpawnBatchContext;
	tasks: any[];
	sessionSlug: string;
}) {
	for (const [index, rawTask] of input.tasks.entries()) {
		const taskContext = readTaskContext({
			deps: input.execution.deps,
			context: input.context,
			params: input.execution.params,
			rawTask,
			sessionSlug: input.sessionSlug,
			index,
			resolveSandboxMode: input.execution.resolveSandboxMode,
		});
		seedTaskAgent(input.context, taskContext, input.execution.deps);
		await launchTask(input.execution.deps, taskContext);
	}
}
async function waitForResults(context: SpawnBatchContext, input: SpawnExecutionInput) {
	if (context.batchId) {
		return input.deps.registry.waitForBatch(context.batchId, input.signal);
	}
	return [await input.deps.registry.waitForAgent(context.agentIds[0], input.signal)];
}
function needsOutputHydration(agent: any): boolean {
	const output = typeof agent?.latestFinalOutput === "string" ? agent.latestFinalOutput.trim() : "";
	return output.length === 0 || output.startsWith("queued:");
}
async function hydrateFinalAgentOutput(deps: SpawnToolDeps, agent: any): Promise<any> {
	if (!agent?.threadId || !needsOutputHydration(agent)) {
		return agent;
	}
	try {
		const threadResponse = await deps.client.readThread(agent.threadId, true);
		const finalText = extractLastCompletedAgentMessage(threadResponse.thread);
		if (!finalText) {
			return agent;
		}
		deps.registry.markCompleted(agent.threadId, agent.activeTurnId ?? null, finalText);
		return deps.registry.getAgent(agent.id) ?? { ...agent, latestFinalOutput: finalText };
	} catch {
		return agent;
	}
}
async function hydrateFinalOutputs(deps: SpawnToolDeps, agents: any[]): Promise<any[]> {
	return Promise.all(agents.map((agent) => hydrateFinalAgentOutput(deps, agent)));
}
function buildResponse(context: SpawnBatchContext, finalAgents: any[]) {
	const text = context.batchId
		? formatSpawnBatchResults(finalAgents, context.promptsByAgentId)
		: formatSpawnAgentResult(finalAgents[0], {
			prompt: context.promptsByAgentId[finalAgents[0].id] ?? null,
		});
	return {
		content: [{ type: "text", text }],
		details: {
			batchId: context.batchId,
			batchName: context.batchName,
			agents: finalAgents,
			promptsByAgentId: context.promptsByAgentId,
		},
	};
}
async function cancelRunningAgents(deps: SpawnToolDeps, agentIds: string[]) {
	for (const agentId of agentIds) {
		const agent = deps.registry.getAgent(agentId);
		if (!agent || agent.state !== "working") {
			continue;
		}
		await cancelAgentRun({
			agent,
			client: deps.client,
			registry: deps.registry,
			note: "Cancelled by Director of Engineering.",
		});
	}
}
async function executeSpawnLike(input: SpawnExecutionInput) {
	const tasks = normalizeSeatTasks(buildTasks(input.params), input.deps.registry);
	const context = createBatchContext(input.params, tasks);
	registerBatch(input.deps.registry, context);
	const stopProgressUpdates = startSpawnProgress(input.deps, context, input.onUpdate);
	try {
		const sessionSlug = requireSessionSlug(input.deps);
		await runTasks({
			execution: input,
			context,
			tasks,
			sessionSlug,
		});
		const initialAgents = await waitForResults(context, input);
		const finalAgents = await hydrateFinalOutputs(input.deps, initialAgents);
		return buildResponse(context, finalAgents);
	} catch (error) {
		if (error instanceof Error && error.message === "Cancelled") {
			await cancelRunningAgents(input.deps, context.agentIds);
		}
		throw error;
	} finally {
		stopProgressUpdates();
	}
}
function createWorkingMessageSetter(ctx: SpawnExecuteContext | undefined) {
	return (summary?: string) => {
		if (!ctx?.hasUI) {
			return;
		}
		ctx.ui?.setWorkingMessage(summary);
	};
}
export function normalizeMultiTaskArgs(args: unknown) {
	if (!isRecord(args)) {
		return args;
	}
	if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
		return args;
	}
	return {
		...args,
		tasks: args.tasks.map((task) => stripTaskControlKeys(task)),
	};
}
export function createSpawnExecuteHandler(input: {
	deps: SpawnToolDeps;
	resolveSandboxMode: (
		role: ICRole | null | undefined,
		sandbox?: SandboxMode | null,
	) => SandboxMode;
}) {
	return async (...args: SpawnExecuteArgs) => {
		const [, params, signal, onUpdate, ctx] = args;
		const deps: SpawnToolDeps = {
			...input.deps,
			setWorkingMessage: createWorkingMessageSetter(ctx),
		};
		return executeSpawnLike({
			params,
			signal,
			onUpdate,
			deps,
			resolveSandboxMode: input.resolveSandboxMode,
		});
	};
}
