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
import { formatUsageCompact } from "../context-usage.ts";
import { getSharedKnowledgebaseContext } from "../plan/flow.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { resolveAgentFinalOutput } from "./agent-final-output.ts";
import { cancelAgentRun } from "./cancel-agent-run.ts";
import { formatContextStatusLines } from "./context-status.ts";
import { readToolProgressSummary, startToolProgressUpdates } from "./progress-updates.ts";
import { resolveResumeTarget } from "./resume-target.ts";
import { resolveSandboxMode } from "./sandbox-mode.ts";
import { AgentLookupFields, SharedExecutionOptionFields } from "./shared-schemas.ts";
import { buildTemplatePrompt } from "./template-prompt.ts";
import { resumeThreadAndStartTurn, steerActiveTurn } from "./thread-turn.ts";

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

function buildPrompt(
	params: any,
	templatesDir: string,
	sharedContext: ReturnType<typeof getSharedKnowledgebaseContext>,
) {
	return buildTemplatePrompt({
		template: params.template,
		prompt: params.prompt,
		templatesDir,
		templateVariables: params.templateVariables,
		sharedContext,
	});
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
		...AgentLookupFields,
		reuseFinished: Type.Optional(Type.Boolean()),
		prompt: Type.String(),
		...SharedExecutionOptionFields,
	}),
} as const;

function isReasoningEffort(value: string | null | undefined): value is ReasoningEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function buildResumeResult(agent: any, text: string) {
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${agent.name}`,
				`state: ${agent.state}`,
				`context: ${formatUsageCompact(agent.usage)}`,
				...formatContextStatusLines(agent.compaction),
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
	if (preferred) {
		return preferred;
	}
	if (isReasoningEffort(agent.effort)) {
		return agent.effort;
	}
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
	const wasSteered = await steerActiveTurn({
		client: deps.client,
		registry: deps.registry,
		agent,
		prompt,
		onBeforeSteer() {
			if (
				requestedAllowWrite === undefined || requestedAllowWrite === (agent.allowWrite ?? false)
			) {
				return;
			}
			throw new Error(
				"Cannot change read/write permission while a turn is already running. Wait for the active turn to finish, then resume with allowWrite set for the next turn.",
			);
		},
	});
	if (wasSteered) {
		return;
	}

	await resumeThreadAndStartTurn({
		client: deps.client,
		registry: deps.registry,
		agentId: agent.id,
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
}

async function resolveResumeFinalText(deps: ResumeToolDeps, agent: any): Promise<string> {
	const text = resolveAgentFinalOutput(agent, null);
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
			if (!ctx?.hasUI) {
				return;
			}
			ctx.ui.setWorkingMessage(summary);
		},
		onStop() {
			if (!ctx?.hasUI) {
				return;
			}
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
			const contextStatus = formatContextStatusLines(agent?.compaction)
				.map((line) => line.replace("context_status: ", ""))
				.join(" ");
			const preview = truncateForDisplay(
				`${formatUsageCompact(agent?.usage)} ${contextStatus} ${
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

export { resolveSandboxMode } from "./sandbox-mode.ts";

export function registerResumeTool(pi: ExtensionAPI, deps: ResumeToolDeps) {
	pi.registerTool(createResumeTool(deps));
}
