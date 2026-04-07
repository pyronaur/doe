import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { summarizeErrorText, truncateForDisplay, type ApprovalPolicy, type ReasoningEffort } from "../codex/client.js";
import { readOptionalModelId, validateModelId } from "../codex/model-selection.js";
import { getSharedKnowledgebaseContext, injectSharedKnowledgebaseContext, type SharedKnowledgebaseContext } from "../plan/flow.js";
import { IC_ROLES } from "../roster/config.js";
import type { DoeRegistry } from "../roster/registry.js";
import type { ICRole, NotificationMode } from "../roster/types.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";
import { readToolProgressSummary, startToolProgressUpdates } from "./progress-updates.js";
import { normalizeSpawnSeatIntent } from "./spawn-seat-intent.js";
import { cancelAgentRun } from "./cancel-agent-run.js";
import { formatSpawnAgentResult, formatSpawnBatchResults, resolveSpawnRenderBody } from "./spawn-result.js";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);
const RoleSchema = StringEnum(IC_ROLES);

const TaskSchema = Type.Object({
	name: Type.Optional(Type.String()),
	ic: Type.Optional(Type.String()),
	role: Type.Optional(RoleSchema),
	prompt: Type.String(),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
});

const SpawnParametersSchema = Type.Object({
	tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 8 })),
	name: Type.Optional(Type.String()),
	ic: Type.Optional(Type.String()),
	role: Type.Optional(RoleSchema),
	prompt: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
	batchName: Type.Optional(Type.String()),
});

interface SpawnToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	getSessionSlug?: () => string | null;
	setWorkingMessage?: (summary?: string) => void;
}

function inferName(prompt: string): string {
	const words = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2);
	return words.join(" ") || "delegate";
}

function buildPrompt(
	task: any,
	templatesDir: string,
	sharedContext: SharedKnowledgebaseContext | null,
): { templateName: string | null; prompt: string; templateDefaultModel: string | null; templateDefaultEffort: ReasoningEffort | null } {
	if (!task.template) {
		return {
			templateName: null,
			prompt: injectSharedKnowledgebaseContext(task.prompt, sharedContext),
			templateDefaultModel: null,
			templateDefaultEffort: null,
		};
	}

	const docs = loadMarkdownDocs(templatesDir);
	const doc = docs.find((entry) => entry.name === task.template);
	if (!doc) {
		throw new Error(`Unknown template "${task.template}". Available: ${docs.map((entry) => entry.name).join(", ") || "none"}`);
	}
	const defaultModel = readOptionalModelId(doc.attributes.default_model, `template "${doc.name}" default_model`);
	const defaultEffort = doc.attributes.default_effort;
	if (defaultEffort !== "low" && defaultEffort !== "medium" && defaultEffort !== "high" && defaultEffort !== "xhigh") {
		throw new Error(`Template "${doc.name}" must define default_effort as one of: low, medium, high, xhigh.`);
	}
	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const variables = {
		task: task.prompt,
		name: task.name,
		cwd: task.cwd,
		...(task.templateVariables ?? {}),
	};
	let rendered = renderMarkdownTemplate(doc, variables).trim();
	if (task.prompt && !usesTaskPlaceholder) {
		rendered = `${rendered}\n\n# Task\n${task.prompt}`.trim();
	}
	rendered = injectSharedKnowledgebaseContext(rendered, sharedContext);
	return {
		templateName: doc.name,
		prompt: rendered,
		templateDefaultModel: defaultModel,
		templateDefaultEffort: defaultEffort,
	};
}

function buildTasks(params: any): any[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) return params.tasks;
	if (!params.prompt || typeof params.prompt !== "string") {
		throw new Error("Provide either tasks[] or a single prompt.");
	}
	return [
		{
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
		},
	];
}

function normalizeMultiTaskArgs(args: unknown) {
	if (!args || typeof args !== "object") return args;
	const input = args as any;
	if (!Array.isArray(input.tasks) || input.tasks.length === 0) return args;
	return {
		...input,
		tasks: input.tasks.map((task: any) => {
			const { returnMode: _taskReturnMode, notificationMode: _taskNotifyMode, ...rest } = task ?? {};
			return rest;
		}),
	};
}

function inferAllowWrite(task: { template?: string | null; allowWrite?: boolean }, templateName: string | null): boolean {
	if (typeof task.allowWrite === "boolean") return task.allowWrite;
	return (templateName ?? task.template ?? null) === "implement";
}

async function executeSpawnLike(
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
	deps: SpawnToolDeps,
) {
	const tasks = buildTasks(params).map((task) => {
		const seatIntent = normalizeSpawnSeatIntent(task, (name) => Boolean(deps.registry.findSeat(name)));
		return {
			...task,
			name: seatIntent.taskName,
			ic: seatIntent.ic,
		};
	});
	const batchId = tasks.length > 1 ? randomUUID() : null;
	const notificationMode = (batchId ? "wait_all" : "notify_each") as NotificationMode;
	const returnMode = "wait" as const;
	const batchName =
		params.batchName ?? (tasks.length > 1 ? `${tasks.length} delegated tasks` : tasks[0]?.name ?? "delegated task");
	const seededAgentIds = tasks.map(() => randomUUID());
	const agentIds = [...seededAgentIds];
	const promptsByAgentId: Record<string, string> = {};
	if (batchId) {
		deps.registry.createBatch({
			id: batchId,
			name: batchName,
			agentIds,
			notificationMode,
			returnMode,
		});
	}
	const stopProgressUpdates = startToolProgressUpdates({
		registry: deps.registry,
		agentIds,
		onUpdate,
		baseDetails: {
			batchId,
			batchName,
			partial: true,
		},
		onProgressSummary: deps.setWorkingMessage,
		onStop: () => deps.setWorkingMessage?.(),
	});

	try {
		let index = 0;
		for (const rawTask of tasks) {
			index += 1;
			const cwd = rawTask.cwd ?? process.cwd();
			const approvalPolicy = (rawTask.approvalPolicy ?? "never") as ApprovalPolicy;
			const networkAccess = rawTask.networkAccess ?? false;
			const sessionSlug = deps.getSessionSlug?.() ?? null;
			if (!sessionSlug) {
				throw new Error("No canonical session slug is set. Call session_set before codex_spawn.");
			}
			const sharedContext = getSharedKnowledgebaseContext(cwd, sessionSlug);
			const { templateName, prompt, templateDefaultModel, templateDefaultEffort } = buildPrompt(rawTask, deps.templatesDir, sharedContext);
			const explicitModel = readOptionalModelId(rawTask.model, "model");
			const model = validateModelId(explicitModel ?? templateDefaultModel ?? "gpt-5.4-mini", explicitModel ? "model" : "resolved model");
			const effort = (rawTask.effort ?? templateDefaultEffort ?? "medium") as ReasoningEffort;
			const allowWrite = inferAllowWrite(rawTask, templateName);
			const agentId = seededAgentIds[index - 1]!;
			promptsByAgentId[agentId] = prompt;
			const seat = deps.registry.assignSeat({
				agentId,
				ic: rawTask.ic ?? null,
				role: (rawTask.role ?? "mid") as ICRole,
			});
			const now = Date.now();

			deps.registry.upsertAgent({
				id: agentId,
				name: seat.name,
				cwd,
				model,
				effort,
				template: templateName,
				allowWrite,
				threadId: null,
				activeTurnId: null,
				state: "working",
				activityLabel: "starting",
				latestSnippet: `queued: ${truncateForDisplay(prompt, 120)}`,
				latestFinalOutput: null,
				lastError: null,
				usage: null,
				compaction: null,
				startedAt: now,
				runStartedAt: now,
				completedAt: null,
				parentBatchId: batchId,
				notificationMode,
				returnMode,
				completionNotified: false,
				recovered: false,
				seatName: seat.name,
				seatRole: seat.role,
				finishNote: null,
				reuseSummary: null,
				messages: [],
				historyHydratedAt: null,
			});

			try {
				const thread = await deps.client.startThread({
					model,
					cwd,
					approvalPolicy,
					networkAccess,
					allowWrite,
				});
				deps.registry.markThreadAttached(agentId, { threadId: thread.thread.id });

				const turn = await deps.client.startTurn({
					threadId: thread.thread.id,
					prompt,
					cwd,
					model,
					effort,
					approvalPolicy,
					networkAccess,
					allowWrite,
				});
				deps.registry.markThreadAttached(agentId, { threadId: thread.thread.id, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(thread.thread.id, turn.turn.id);
				deps.registry.appendUserMessage(agentId, turn.turn.id, prompt);
			} catch (error) {
				deps.registry.markAgentError(agentId, summarizeErrorText(error));
				throw error;
			}
		}

		const finalAgents = batchId
			? await deps.registry.waitForBatch(batchId, signal)
			: [await deps.registry.waitForAgent(agentIds[0]!, signal)];
		const text = batchId
			? formatSpawnBatchResults(finalAgents, promptsByAgentId)
			: formatSpawnAgentResult(finalAgents[0], { prompt: promptsByAgentId[finalAgents[0].id] ?? null });
		return {
			content: [{ type: "text", text }],
			details: {
				batchId,
				batchName,
				agents: finalAgents,
				promptsByAgentId,
			},
		};
	} catch (error) {
		if (error instanceof Error && error.message === "Cancelled") {
			for (const agentId of agentIds) {
				const agent = deps.registry.getAgent(agentId);
				if (!agent || agent.state !== "working") continue;
				await cancelAgentRun({
					agent,
					client: deps.client,
					registry: deps.registry,
					note: "Cancelled by Director of Engineering.",
				});
			}
		}
		throw error;
	} finally {
		stopProgressUpdates();
	}
}

export function registerSpawnTool(pi: ExtensionAPI, deps: SpawnToolDeps) {
	pi.registerTool({
		name: "codex_spawn",
		label: "Codex Spawn",
		description: "Spawn one or more named IC assignments. Each task gets its own thread and seat.",
		promptSnippet: "Spawn new Codex workers for scanning, research, planning, or implementation. Use tasks[] for parallel independent work.",
		promptGuidelines: [
			"Use for new work only. Do not use when an existing thread has relevant context — use codex_resume instead.",
			"Use name for the task label. Use ic for seat targeting.",
			"Fresh spawn on the same seat starts a new thread and does not preserve thread memory. Use codex_resume when the same thread context should continue.",
			"Pass ic to target a specific named seat, or role to auto-allocate the next free IC in senior|mid|research.",
			"Compatibility shim: if name exactly matches an existing seat and ic is omitted, DOE treats that name as the intended seat.",
			"Each new task gets a fresh assignment. If a role is full, DOE allocates contractor-N overflow seats.",
			"Specify model and reasoning separately: use model like gpt-5.4 and effort like low|medium|high|xhigh. Do not pass combined strings like gpt-5.4-high.",
			"Workers are read-only by default. Set allowWrite=true per task, or use template=implement which enables write automatically.",
			"Waits for workers to complete and returns each worker's full final answer in content. Use that returned content directly as the worker result.",
		],
		parameters: SpawnParametersSchema,
		prepareArguments: normalizeMultiTaskArgs,
		renderCall(args, theme) {
			const taskCount = Array.isArray((args as any).tasks) ? (args as any).tasks.length : 1;
			const label = taskCount > 1 ? `${taskCount} agents` : "1 agent";
			return new Text(theme.fg("accent", `codex_spawn ${label}`), 0, 0);
		},
		renderResult(result, options, theme) {
			if (options.isPartial && readToolProgressSummary(result)) {
				return new Container();
			}
			return new Text(resolveSpawnRenderBody(result as any), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const setWorkingMessage = (summary?: string) => {
				if (!ctx?.hasUI) return;
				ctx.ui.setWorkingMessage(summary);
			};
			return executeSpawnLike(params, signal, onUpdate as any, {
				...deps,
				setWorkingMessage,
			} as SpawnToolDeps & { setWorkingMessage?: (summary?: string) => void });
		},
	});

	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description: "Alias for codex_spawn.",
		promptSnippet: "Alias of codex_spawn — identical behavior.",
		promptGuidelines: ["Use codex_spawn instead. Both tools are identical."],
		parameters: SpawnParametersSchema,
		prepareArguments: normalizeMultiTaskArgs,
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_delegate ${(args as any).batchName ?? "task"}`), 0, 0);
		},
		renderResult(result, options, theme) {
			if (options.isPartial && readToolProgressSummary(result)) {
				return new Container();
			}
			return new Text(resolveSpawnRenderBody(result as any), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const setWorkingMessage = (summary?: string) => {
				if (!ctx?.hasUI) return;
				ctx.ui.setWorkingMessage(summary);
			};
			return executeSpawnLike(params, signal, onUpdate as any, {
				...deps,
				setWorkingMessage,
			} as SpawnToolDeps & { setWorkingMessage?: (summary?: string) => void });
		},
	});
}
