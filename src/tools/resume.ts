import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import {
	type ApprovalPolicy,
	extractLastCompletedAgentMessage,
	type ReasoningEffort,
	type SandboxMode,
	truncateForDisplay,
} from "../codex/client.ts";
import { readOptionalModelId, validateModelId } from "../codex/model-selection.ts";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.ts";
import {
	getSharedKnowledgebaseContext,
	injectSharedKnowledgebaseContext,
	type SharedKnowledgebaseContext,
} from "../plan/flow.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.ts";
import { cancelAgentRun } from "./cancel-agent-run.ts";
import { readToolProgressSummary, startToolProgressUpdates } from "./progress-updates.ts";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);
const SandboxSchema = StringEnum(["read-only", "workspace-write", "danger-full-access"] as const);

interface ResumeToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	getSessionSlug?: () => string | null;
}

interface ResumeWorkflowInput {
	deps: ResumeToolDeps;
	params: any;
	signal?: AbortSignal;
	onUpdate?: (update: any) => void;
	ctx?: { hasUI?: boolean; ui?: { setWorkingMessage(summary?: string): void } };
}

interface ResumeAgentSeedInput {
	deps: ResumeToolDeps;
	agent: any;
	prompt: string;
	templateName: string | null;
	model: string;
	effort: ReasoningEffort;
	allowWrite: boolean;
}

interface ResumeTurnInput {
	deps: ResumeToolDeps;
	agent: any;
	prompt: string;
	model: string;
	effort: ReasoningEffort;
	approvalPolicy: ApprovalPolicy;
	networkAccess: boolean;
	allowWrite: boolean;
	sandbox: SandboxMode;
	requestedAllowWrite?: boolean;
}

interface ResumeExecutionContext {
	templateName: string | null;
	prompt: string;
	model: string;
	effort: ReasoningEffort;
	requestedAllowWrite: boolean | undefined;
	allowWrite: boolean;
	approvalPolicy: ApprovalPolicy;
	networkAccess: boolean;
	sandbox: SandboxMode;
}

interface ResumeProgressInput {
	deps: ResumeToolDeps;
	agentId: string;
	onUpdate: ((update: any) => void) | undefined;
	ctx: ResumeWorkflowInput["ctx"];
}

function resolveAgentFinalOutput(agent: any): string | null {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) =>
			message?.role === "agent" && typeof message?.text === "string"
			&& message.text.trim().length > 0
		)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? null;
}

function buildPrompt(
	params: any,
	templatesDir: string,
	sharedContext: SharedKnowledgebaseContext | null,
): {
	templateName: string | null;
	prompt: string;
	templateDefaultModel: string | null;
	templateDefaultEffort: ReasoningEffort | null;
} {
	if (!params.template) {
		return {
			templateName: null,
			prompt: injectSharedKnowledgebaseContext(params.prompt, sharedContext),
			templateDefaultModel: null,
			templateDefaultEffort: null,
		};
	}

	const docs = loadMarkdownDocs(templatesDir);
	const doc = docs.find((entry) => entry.name === params.template);
	if (!doc) {
		throw new Error(`Unknown template "${params.template}".`);
	}

	const defaultModel = readOptionalModelId(
		doc.attributes.default_model,
		`template "${doc.name}" default_model`,
	);
	const defaultEffort = doc.attributes.default_effort;
	if (
		defaultEffort !== "low" && defaultEffort !== "medium" && defaultEffort !== "high"
		&& defaultEffort !== "xhigh"
	) {
		throw new Error(
			`Template "${doc.name}" must define default_effort as one of: low, medium, high, xhigh.`,
		);
	}

	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const rendered = renderMarkdownTemplate(doc, {
		task: params.prompt,
		...params.templateVariables,
	}).trim();

	return {
		templateName: doc.name,
		prompt: injectSharedKnowledgebaseContext(
			usesTaskPlaceholder || !params.prompt ? rendered : `${rendered}\n\n# Task\n${params.prompt}`,
			sharedContext,
		),
		templateDefaultModel: defaultModel,
		templateDefaultEffort: defaultEffort,
	};
}

function resolveResumeTarget(registry: DoeRegistry, params: any) {
	if (params.ic) {
		const active = registry.findActiveSeatAgent(params.ic);
		if (active) {return active;}
		if (params.reuseFinished) {
			const finished = registry.findLastFinishedSeatAgent(params.ic);
			if (finished) {return finished;}
		}
		if (registry.findSeat(params.ic)) {
			throw new Error(
				`No active assignment is attached to ${params.ic}. Use codex_spawn for fresh work on that seat, or set reuseFinished=true to reopen the last finished context.`,
			);
		}
	}
	if (params.agentId) {return registry.findAgent(params.agentId);}
	if (params.threadId) {return registry.findAgent(params.threadId);}
	return undefined;
}

const RESUME_TOOL_META = {
	name: "codex_resume",
	label: "Codex Resume",
	description: "Resume or steer an existing Codex thread by IC seat, agentId, or threadId.",
	promptSnippet:
		"Resume an existing thread instead of spawning fresh when the work continues the same investigation or task.",
	promptGuidelines: [
		"Prefer ic for named-seat lookup. agentId and threadId remain available for legacy/debug use.",
		"Use reuseFinished=true only when DOE explicitly wants the last finished context on that seat.",
		"Do not resume a finished unrelated task just because the seat name matches. Spawn fresh work on that seat instead.",
		"Does not accept tasks[], name, cwd, or batchName.",
		"Specify model and reasoning separately: use model like gpt-5.4 and effort like low|medium|high|xhigh. Do not pass combined strings like gpt-5.4-high.",
		"Sandbox follows DOE role policy. `allowWrite` only controls auto-approval of file-change requests; use `sandbox=\"danger-full-access\"` to opt a mid-level IC into full access.",
		"Waits for the worker to finish before returning and returns the worker's full final answer in content. Use that returned content directly as the worker result.",
	],
	parameters: Type.Object({
		ic: Type.Optional(Type.String()),
		agentId: Type.Optional(Type.String()),
		threadId: Type.Optional(Type.String()),
		reuseFinished: Type.Optional(Type.Boolean()),
		prompt: Type.String(),
		model: Type.Optional(Type.String()),
		effort: Type.Optional(EffortSchema),
		template: Type.Optional(Type.String()),
		templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
		approvalPolicy: Type.Optional(ApprovalSchema),
		networkAccess: Type.Optional(Type.Boolean()),
		allowWrite: Type.Optional(Type.Boolean()),
		sandbox: Type.Optional(SandboxSchema),
	}),
} as const;

function isReasoningEffort(value: string | null | undefined): value is ReasoningEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function buildResumeResult(agent: any, text: string) {
	const compaction = formatCompactionSignal(agent.compaction);
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${agent.name}`,
				`state: ${agent.state}`,
				`context: ${formatUsageCompact(agent.usage)}`,
				...(compaction ? [`context_status: ${compaction}`] : []),
				"",
				text,
			].join("\n"),
		}],
		details: { agent },
	};
}

function resolveResumeEffort(
	agent: any,
	preferred: ReasoningEffort | null | undefined,
): ReasoningEffort {
	if (preferred) {return preferred;}
	if (isReasoningEffort(agent.effort)) {return agent.effort;}
	return "medium";
}

function resolveResumeModel(
	agent: any,
	explicitModel: string | null,
	templateDefaultModel: string | null,
): string {
	if (explicitModel) {
		return validateModelId(explicitModel, "model");
	}
	if (templateDefaultModel) {
		return validateModelId(templateDefaultModel, "resolved model");
	}
	return validateModelId(agent.model, `stored model for agent ${agent.id}`);
}

function seedResumeAgent(input: ResumeAgentSeedInput) {
	const { deps, agent, prompt, templateName, model, effort, allowWrite } = input;
	deps.registry.upsertAgent({
		...agent,
		model,
		effort,
		template: templateName ?? agent.template,
		state: "working",
		activityLabel: "starting",
		allowWrite,
		latestSnippet: `resume: ${truncateForDisplay(prompt, 120)}`,
		latestFinalOutput: null,
		completedAt: null,
		notificationMode: agent.notificationMode ?? "notify_each",
		returnMode: "wait",
		completionNotified: false,
		messages: agent.messages ?? [],
		historyHydratedAt: agent.historyHydratedAt ?? null,
		runStartedAt: Date.now(),
	});
}

async function runResumeTurn(input: ResumeTurnInput) {
	const {
		deps,
		agent,
		prompt,
		model,
		effort,
		approvalPolicy,
		networkAccess,
		allowWrite,
		sandbox,
		requestedAllowWrite,
	} = input;
	if (agent.activeTurnId && agent.state === "working") {
		if (
			requestedAllowWrite !== undefined && requestedAllowWrite !== (agent.allowWrite ?? false)
		) {
			throw new Error(
				"Cannot change read/write permission while a turn is already running. Wait for the active turn to finish, then resume with allowWrite set for the next turn.",
			);
		}
		await deps.client.steerTurn({
			threadId: agent.threadId,
			expectedTurnId: agent.activeTurnId,
			prompt,
		});
		deps.registry.appendUserMessage(agent.id, agent.activeTurnId, prompt);
		return;
	}

	await deps.client.resumeThread({
		threadId: agent.threadId,
		cwd: agent.cwd,
		model,
		approvalPolicy,
		allowWrite,
		sandbox,
	});
	const turn = await deps.client.startTurn({
		threadId: agent.threadId,
		prompt,
		cwd: agent.cwd,
		model,
		effort,
		approvalPolicy,
		networkAccess,
		allowWrite,
		sandbox,
	});
	deps.registry.markThreadAttached(agent.id, {
		threadId: agent.threadId,
		activeTurnId: turn.turn.id,
	});
	deps.registry.markTurnStarted(agent.threadId, turn.turn.id);
	deps.registry.appendUserMessage(agent.id, turn.turn.id, prompt);
}

async function resolveResumeFinalText(deps: ResumeToolDeps, agent: any): Promise<string> {
	const text = resolveAgentFinalOutput(agent);
	if (text || !agent.threadId) {
		return text ?? "Completed";
	}
	const threadResponse = await deps.client.readThread(agent.threadId, true);
	return extractLastCompletedAgentMessage(threadResponse.thread) ?? "Completed";
}

function buildResumeExecutionContext(
	input: ResumeWorkflowInput,
	agent: any,
	sessionSlug: string,
): ResumeExecutionContext {
	const { deps, params } = input;
	const sharedContext = getSharedKnowledgebaseContext(agent.cwd, sessionSlug);
	const { templateName, prompt, templateDefaultModel, templateDefaultEffort } = buildPrompt(
		params,
		deps.templatesDir,
		sharedContext,
	);
	const explicitModel = readOptionalModelId(params.model, "model");
	const model = resolveResumeModel(agent, explicitModel, templateDefaultModel);
	const effort = resolveResumeEffort(agent, params.effort ?? templateDefaultEffort);
	const requestedAllowWrite = params.allowWrite;
	const allowWrite = params.allowWrite
		?? ((templateName ?? params.template ?? agent.template ?? null) === "implement"
			? true
			: (agent.allowWrite ?? false));
	return {
		templateName,
		prompt,
		model,
		effort,
		requestedAllowWrite,
		allowWrite,
		approvalPolicy: params.approvalPolicy ?? "never",
		networkAccess: params.networkAccess ?? false,
		sandbox: resolveSandboxMode(agent.seatRole ?? null, params.sandbox),
	};
}

function startResumeProgressUpdates(input: ResumeProgressInput) {
	const { deps, agentId, onUpdate, ctx } = input;
	return startToolProgressUpdates({
		registry: deps.registry,
		agentIds: [agentId],
		onUpdate,
		baseDetails: {
			partial: true,
		},
		onProgressSummary(summary) {
			if (!ctx?.hasUI) {return;}
			ctx.ui.setWorkingMessage(summary);
		},
		onStop() {
			if (!ctx?.hasUI) {return;}
			ctx.ui.setWorkingMessage();
		},
	});
}

async function executeResumeWorkflow(input: ResumeWorkflowInput) {
	const { deps, params, signal, onUpdate, ctx } = input;
	const agent = resolveResumeTarget(deps.registry, params);
	if (!agent?.threadId) {
		throw new Error(
			"Unknown IC/agent/thread. Provide an active seat name, or an existing agentId/threadId from codex_list/codex_inspect.",
		);
	}

	const sessionSlug = deps.getSessionSlug?.() ?? null;
	if (!sessionSlug) {
		throw new Error("No canonical session slug is set. Call session_set before codex_resume.");
	}

	const runtime = buildResumeExecutionContext(input, agent, sessionSlug);
	const stopProgressUpdates = startResumeProgressUpdates({
		deps,
		agentId: agent.id,
		onUpdate,
		ctx,
	});

	try {
		seedResumeAgent({
			deps,
			agent,
			prompt: runtime.prompt,
			templateName: runtime.templateName,
			model: runtime.model,
			effort: runtime.effort,
			allowWrite: runtime.allowWrite,
		});
		await runResumeTurn({
			deps,
			agent,
			prompt: runtime.prompt,
			model: runtime.model,
			effort: runtime.effort,
				approvalPolicy: runtime.approvalPolicy,
				networkAccess: runtime.networkAccess,
				allowWrite: runtime.allowWrite,
				sandbox: runtime.sandbox,
				requestedAllowWrite: runtime.requestedAllowWrite,
			});
		const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
		const text = await resolveResumeFinalText(deps, finalAgent);
		return buildResumeResult(finalAgent, text);
	} catch (error) {
		if (error instanceof Error && error.message === "Cancelled") {
			await cancelAgentRun({
				agent: deps.registry.getAgent(agent.id) ?? agent,
				client: deps.client,
				registry: deps.registry,
				note: "Cancelled by Director of Engineering.",
			});
		}
		throw error;
	} finally {
		stopProgressUpdates();
	}
}

function createResumeTool(deps: ResumeToolDeps) {
	return {
		...RESUME_TOOL_META,
		renderCall(args, theme) {
			return new Text(
				theme.fg("accent", `codex_resume ${args.ic ?? args.agentId ?? args.threadId ?? "thread"}`),
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			if (options.isPartial && readToolProgressSummary(result)) {
				return new Container();
			}
			const agent = result.details?.agent;
			const preview = truncateForDisplay(
				`${formatUsageCompact(agent?.usage)}${
					formatCompactionSignal(agent?.compaction)
						? ` ${formatCompactionSignal(agent?.compaction)}`
						: ""
				} ${
					agent?.latestFinalOutput ?? agent?.latestSnippet ?? result.content?.[0]?.text ?? "Resumed"
				}`,
				240,
			);
			return new Text(theme.fg("accent", preview), 0, 0);
		},
		async execute(
			...args: [
				string,
				any,
				AbortSignal | undefined,
				((update: any) => void) | undefined,
				{ hasUI?: boolean; ui?: { setWorkingMessage(summary?: string): void } } | undefined,
			]
		) {
			const [, params, signal, onUpdate, ctx] = args;
			return executeResumeWorkflow({ deps, params, signal, onUpdate, ctx });
		},
	};
}

export function resolveSandboxMode(role: string | null | undefined, sandbox?: SandboxMode | null): SandboxMode {
	if (role === "researcher" || role === "senior") {return "danger-full-access";}
	if (role === "mid") {return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";}
	return "read-only";
}

export function registerResumeTool(pi: ExtensionAPI, deps: ResumeToolDeps) {pi.registerTool(createResumeTool(deps));}
