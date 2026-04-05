import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { truncateForDisplay, type ApprovalPolicy, type ReasoningEffort } from "../codex/client.js";
import type { NotificationMode, ReturnMode, SysopRegistry } from "../state/registry.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const NotifySchema = StringEnum(["wait_all", "notify_each"] as const);
const ReturnModeSchema = StringEnum(["wait", "async"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);

const TaskSchema = Type.Object({
	name: Type.String(),
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
	prompt: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
	notificationMode: Type.Optional(NotifySchema),
	returnMode: Type.Optional(ReturnModeSchema),
	batchName: Type.Optional(Type.String()),
});

interface SpawnToolDeps {
	client: CodexAppServerClient;
	registry: SysopRegistry;
	templatesDir: string;
}

function inferName(prompt: string): string {
	const words = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2);
	return words.join(" ") || "delegate";
}

function buildPrompt(task: any, templatesDir: string): { templateName: string | null; prompt: string } {
	if (!task.template) {
		return {
			templateName: null,
			prompt: task.prompt,
		};
	}

	const docs = loadMarkdownDocs(templatesDir);
	const doc = docs.find((entry) => entry.name === task.template);
	if (!doc) {
		throw new Error(`Unknown template "${task.template}". Available: ${docs.map((entry) => entry.name).join(", ") || "none"}`);
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
	return {
		templateName: doc.name,
		prompt: rendered,
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
	const firstTask = input.tasks[0] ?? {};
	return {
		...input,
		returnMode: input.returnMode ?? firstTask.returnMode,
		notificationMode: input.notificationMode ?? firstTask.notificationMode,
		tasks: input.tasks.map((task: any) => {
			const { returnMode: _taskReturnMode, notificationMode: _taskNotifyMode, ...rest } = task ?? {};
			return rest;
		}),
	};
}

function summarizeAgents(agents: Array<any>, maxSnippet = 120): string {
	return agents
		.map((agent) => `- ${agent.name} [${agent.state}] ${agent.model} — ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, maxSnippet)}`)
		.join("\n");
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
	const tasks = buildTasks(params);
	const notificationMode = (params.notificationMode ?? "notify_each") as NotificationMode;
	const returnMode = (params.returnMode ?? (notificationMode === "wait_all" ? "wait" : "async")) as ReturnMode;
	const batchId = tasks.length > 1 ? randomUUID() : null;
	const batchName =
		params.batchName ?? (tasks.length > 1 ? `${tasks.length} delegated tasks` : tasks[0]?.name ?? "delegated task");
	const seededAgentIds = tasks.map(() => randomUUID());
	const agentIds = [...seededAgentIds];
	if (batchId) {
		deps.registry.createBatch({
			id: batchId,
			name: batchName,
			agentIds,
			notificationMode,
			returnMode,
		});
	}

	const createdAgents: any[] = [];
	let index = 0;
	for (const rawTask of tasks) {
		index += 1;
		const cwd = rawTask.cwd ?? process.cwd();
		const model = rawTask.model ?? "gpt-5.4-mini";
		const effort = (rawTask.effort ?? "medium") as ReasoningEffort;
		const approvalPolicy = (rawTask.approvalPolicy ?? "never") as ApprovalPolicy;
		const networkAccess = rawTask.networkAccess ?? false;
		const name = rawTask.name?.trim() || inferName(rawTask.prompt);
		const { templateName, prompt } = buildPrompt(rawTask, deps.templatesDir);
		const allowWrite = inferAllowWrite(rawTask, templateName);
		const agentId = seededAgentIds[index - 1]!;

		deps.registry.upsertAgent({
			id: agentId,
			name,
			cwd,
			model,
			effort,
			template: templateName,
			allowWrite,
			threadId: null,
			activeTurnId: null,
			state: "working",
			latestSnippet: `queued: ${truncateForDisplay(prompt, 120)}`,
			latestFinalOutput: null,
			lastError: null,
			startedAt: Date.now(),
			completedAt: null,
			parentBatchId: batchId,
			notificationMode,
			returnMode,
			completionNotified: false,
			recovered: false,
		});

		onUpdate?.({
			content: [{ type: "text", text: `Launching ${name} (${index}/${tasks.length})` }],
			details: { index, total: tasks.length, agentId, name, allowWrite },
		});

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
		createdAgents.push(deps.registry.getAgent(agentId));
	}

	if (returnMode === "wait") {
		const finalAgents = batchId
			? await deps.registry.waitForBatch(batchId, signal)
			: [await deps.registry.waitForAgent(agentIds[0]!, signal)];
		return {
			content: [
				{
					type: "text",
					text: [`All delegated work completed for ${batchName}.`, summarizeAgents(finalAgents, 96) || "Completed", "Answer the user now using these results."].join("\n"),
				},
			],
			details: {
				batchId,
				batchName,
				agents: finalAgents,
			},
		};
	}

	const completionMode = notificationMode === "wait_all" ? "one completion steer when the batch finishes" : "a completion steer for each worker";
	return {
		content: [
			{
				type: "text",
				text: `Spawned ${agentIds.length} Codex ${agentIds.length === 1 ? "agent" : "agents"} in ${batchId ? `batch ${batchName}` : "single mode"}. Wait for ${completionMode}; do not poll with codex_inspect unless the user explicitly asks for a live check.`,
			},
		],
		details: {
			batchId,
			batchName,
			agents: createdAgents,
		},
	};
}

export function registerSpawnTool(pi: ExtensionAPI, deps: SpawnToolDeps) {
	pi.registerTool({
		name: "codex_spawn",
		label: "Codex Spawn",
		description: "Spawn one or more Codex workstreams through the Codex app-server.",
		promptSnippet: "Spawn one or more Codex sub-agents for scanning, research, planning, or implementation work.",
		promptGuidelines: [
			"Use this tool instead of researching or coding directly.",
			"Pass multiple tasks in tasks[] when you want parallel workers.",
			"Set notificationMode=wait_all for batches that should report together.",
			"For async work, return after launch and wait for the completion steer instead of polling with codex_inspect.",
			"Workers are read-only by default. Only set allowWrite=true or use template=implement for explicit implementation work.",
		],
		parameters: SpawnParametersSchema,
		prepareArguments: normalizeMultiTaskArgs,
		renderCall(args, theme) {
			const taskCount = Array.isArray((args as any).tasks) ? (args as any).tasks.length : 1;
			const mode = (args as any).notificationMode ?? "notify_each";
			const label = taskCount > 1 ? `${taskCount} agents` : "1 agent";
			return new Text(theme.fg("accent", `codex_spawn ${label}`) + theme.fg("dim", ` (${mode})`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = (result as any).details ?? {};
			const agents = Array.isArray(details.agents) ? details.agents : [];
			const batch = details.batchId ? `batch=${details.batchId}` : "single";
			const body = agents.length > 0 ? summarizeAgents(agents) : result.content?.[0]?.text ?? "Spawned";
			return new Text(`${theme.fg("accent", `sysop ${batch}`)}\n${body}`, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeSpawnLike(params, signal, onUpdate as any, deps);
		},
	});

	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description: "Alias for codex_spawn with the same parameters.",
		promptSnippet: "Alias of codex_spawn for delegation-oriented language.",
		promptGuidelines: [
			"Use this for new delegated research, planning, or implementation tasks.",
			"Do not use codex_inspect as a polling loop after an async delegate; wait for completion steers.",
		],
		parameters: SpawnParametersSchema,
		prepareArguments: normalizeMultiTaskArgs,
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_delegate ${(args as any).batchName ?? "task"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "Delegated"), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeSpawnLike(params, signal, onUpdate as any, deps);
		},
	});
}
