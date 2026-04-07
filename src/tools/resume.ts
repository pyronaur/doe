import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import {
	extractLastCompletedAgentMessage,
	truncateForDisplay,
	type ApprovalPolicy,
	type ReasoningEffort,
	type SandboxMode,
} from "../codex/client.js";
import { formatCompactionSignal, formatUsageCompact } from "../context-usage.js";
import { readOptionalModelId, validateModelId } from "../codex/model-selection.js";
import { getSharedKnowledgebaseContext, injectSharedKnowledgebaseContext, type SharedKnowledgebaseContext } from "../plan/flow.js";
import type { DoeRegistry } from "../roster/registry.js";
import type { NotificationMode } from "../roster/types.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";
import { readToolProgressSummary, startToolProgressUpdates } from "./progress-updates.js";
import { cancelAgentRun } from "./cancel-agent-run.js";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);
const SandboxSchema = StringEnum(["read-only", "workspace-write", "danger-full-access"] as const);

interface ResumeToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	getSessionSlug?: () => string | null;
}

function resolveAgentFinalOutput(agent: any): string | null {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) => message?.role === "agent" && typeof message?.text === "string" && message.text.trim().length > 0)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? null;
}

export function resolveSandboxMode(role: string | null | undefined, sandbox?: SandboxMode | null): SandboxMode {
	if (role === "senior") return "danger-full-access";
	if (role === "mid") return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";
	return "read-only";
}

function buildPrompt(
	params: any,
	templatesDir: string,
	sharedContext: SharedKnowledgebaseContext | null,
): { templateName: string | null; prompt: string; templateDefaultModel: string | null; templateDefaultEffort: ReasoningEffort | null } {
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
	if (!doc) throw new Error(`Unknown template "${params.template}".`);
	const defaultModel = readOptionalModelId(doc.attributes.default_model, `template "${doc.name}" default_model`);
	const defaultEffort = doc.attributes.default_effort;
	if (defaultEffort !== "low" && defaultEffort !== "medium" && defaultEffort !== "high" && defaultEffort !== "xhigh") {
		throw new Error(`Template "${doc.name}" must define default_effort as one of: low, medium, high, xhigh.`);
	}
	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const rendered = renderMarkdownTemplate(doc, { task: params.prompt, ...(params.templateVariables ?? {}) }).trim();
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
		if (active) return active;
		if (params.reuseFinished) {
			const finished = registry.findLastFinishedSeatAgent(params.ic);
			if (finished) return finished;
		}
		if (registry.findSeat(params.ic)) {
			throw new Error(`No active assignment is attached to ${params.ic}. Use codex_spawn for fresh work on that seat, or set reuseFinished=true to reopen the last finished context.`);
		}
	}
	if (params.agentId) return registry.findAgent(params.agentId);
	if (params.threadId) return registry.findAgent(params.threadId);
	return undefined;
}

export function registerResumeTool(pi: ExtensionAPI, deps: ResumeToolDeps) {
	pi.registerTool({
		name: "codex_resume",
		label: "Codex Resume",
		description: "Resume or steer an existing Codex thread by IC seat, agentId, or threadId.",
		promptSnippet: "Resume an existing thread instead of spawning fresh when the work continues the same investigation or task.",
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
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_resume ${(args as any).ic ?? (args as any).agentId ?? (args as any).threadId ?? "thread"}`), 0, 0);
		},
		renderResult(result, options, theme) {
			if (options.isPartial && readToolProgressSummary(result)) {
				return new Container();
			}
			const agent = (result as any).details?.agent;
			const preview = truncateForDisplay(`${formatUsageCompact(agent?.usage)}${formatCompactionSignal(agent?.compaction) ? ` ${formatCompactionSignal(agent?.compaction)}` : ""} ${agent?.latestFinalOutput ?? agent?.latestSnippet ?? result.content?.[0]?.text ?? "Resumed"}`, 240);
			return new Text(theme.fg("accent", preview), 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agent = resolveResumeTarget(deps.registry, params);
			if (!agent?.threadId) {
				throw new Error("Unknown IC/agent/thread. Provide an active seat name, or an existing agentId/threadId from codex_list/codex_inspect.");
			}

			const notificationMode = (agent.notificationMode ?? "notify_each") as NotificationMode;
			const returnMode = "wait" as const;
			const approvalPolicy = (params.approvalPolicy ?? "never") as ApprovalPolicy;
			const networkAccess = params.networkAccess ?? false;
			const sessionSlug = deps.getSessionSlug?.() ?? null;
			if (!sessionSlug) {
				throw new Error("No canonical session slug is set. Call session_set before codex_resume.");
			}
			const sharedContext = getSharedKnowledgebaseContext(agent.cwd, sessionSlug);
			const { templateName, prompt, templateDefaultModel, templateDefaultEffort } = buildPrompt(params, deps.templatesDir, sharedContext);
			const effort = (params.effort ?? templateDefaultEffort ?? agent.effort ?? "medium") as ReasoningEffort;
			const explicitModel = readOptionalModelId(params.model, "model");
			const inheritedModel = explicitModel || templateDefaultModel ? null : validateModelId(agent.model, `stored model for agent ${agent.id}`);
			const model = validateModelId(explicitModel ?? templateDefaultModel ?? inheritedModel ?? agent.model, explicitModel ? "model" : "resolved model");
			const allowWrite = params.allowWrite ?? ((templateName ?? params.template ?? agent.template ?? null) === "implement" ? true : (agent.allowWrite ?? false));
			const sandbox = resolveSandboxMode(agent.seatRole ?? null, params.sandbox);
			const runStartedAt = Date.now();

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
				runStartedAt,
				completedAt: null,
				notificationMode,
				returnMode,
				completionNotified: false,
				messages: agent.messages ?? [],
				historyHydratedAt: agent.historyHydratedAt ?? null,
			});
			const stopProgressUpdates = startToolProgressUpdates({
				registry: deps.registry,
				agentIds: [agent.id],
				onUpdate: onUpdate as any,
				baseDetails: {
					partial: true,
				},
				onProgressSummary(summary) {
					if (!ctx?.hasUI) return;
					ctx.ui.setWorkingMessage(summary);
				},
				onStop() {
					if (!ctx?.hasUI) return;
					ctx.ui.setWorkingMessage();
				},
			});

			try {
				if (agent.activeTurnId && agent.state === "working") {
					if (params.allowWrite !== undefined && params.allowWrite !== (agent.allowWrite ?? false)) {
						throw new Error("Cannot change read/write permission while a turn is already running. Wait for the active turn to finish, then resume with allowWrite set for the next turn.");
					}
					await deps.client.steerTurn({
						threadId: agent.threadId,
						expectedTurnId: agent.activeTurnId,
						prompt,
					});
					deps.registry.appendUserMessage(agent.id, agent.activeTurnId, prompt);
				} else {
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
					deps.registry.markThreadAttached(agent.id, { threadId: agent.threadId, activeTurnId: turn.turn.id });
					deps.registry.markTurnStarted(agent.threadId, turn.turn.id);
					deps.registry.appendUserMessage(agent.id, turn.turn.id, prompt);
				}

				const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
				let text = resolveAgentFinalOutput(finalAgent);
				if (!text && finalAgent.threadId) {
					const threadResponse = await deps.client.readThread(finalAgent.threadId, true);
					text = extractLastCompletedAgentMessage(threadResponse.thread);
				}
				return {
					content: [{ type: "text", text: [`ic: ${finalAgent.name}`, `state: ${finalAgent.state}`, `context: ${formatUsageCompact(finalAgent.usage)}`, ...(formatCompactionSignal(finalAgent.compaction) ? [`context_status: ${formatCompactionSignal(finalAgent.compaction)}`] : []), "", text ?? "Completed"].join("\n") }],
					details: { agent: finalAgent },
				};
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
		},
	});
}
