import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { truncateForDisplay, type ApprovalPolicy, type ReasoningEffort } from "../codex/client.js";
import { readOptionalModelId, validateModelId } from "../codex/model-selection.js";
import type { NotificationMode, DoeRegistry } from "../state/registry.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);

interface ResumeToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
}

function buildPrompt(
	params: any,
	templatesDir: string,
): { templateName: string | null; prompt: string; templateDefaultModel: string | null; templateDefaultEffort: ReasoningEffort | null } {
	if (!params.template) {
		return { templateName: null, prompt: params.prompt, templateDefaultModel: null, templateDefaultEffort: null };
	}
	const docs = loadMarkdownDocs(templatesDir);
	const doc = docs.find((entry) => entry.name === params.template);
	if (!doc) throw new Error(`Unknown template \"${params.template}\".`);
	const defaultModel = readOptionalModelId(doc.attributes.default_model, `template \"${doc.name}\" default_model`);
	const defaultEffort = doc.attributes.default_effort;
	if (defaultEffort !== "low" && defaultEffort !== "medium" && defaultEffort !== "high" && defaultEffort !== "xhigh") {
		throw new Error(`Template "${doc.name}" must define default_effort as one of: low, medium, high, xhigh.`);
	}
	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const rendered = renderMarkdownTemplate(doc, { task: params.prompt, ...(params.templateVariables ?? {}) }).trim();
	return {
		templateName: doc.name,
		prompt: usesTaskPlaceholder || !params.prompt ? rendered : `${rendered}\n\n# Task\n${params.prompt}`,
		templateDefaultModel: defaultModel,
		templateDefaultEffort: defaultEffort,
	};
}

export function registerResumeTool(pi: ExtensionAPI, deps: ResumeToolDeps) {
	pi.registerTool({
		name: "codex_resume",
		label: "Codex Resume",
		description: "Resume or steer an existing Codex thread by agentId or threadId.",
		promptSnippet: "Resume an existing thread instead of spawning fresh when the work continues the same investigation or task.",
		promptGuidelines: [
			"Requires agentId (available from codex_list) or threadId (available from codex_inspect).",
			"Does not accept tasks[], name, cwd, or batchName.",
			"Specify model and reasoning separately: use model like gpt-5.4 and effort like low|medium|high|xhigh. Do not pass combined strings like gpt-5.4-high.",
			"Keep read-only unless this is explicit implementation work — set allowWrite=true only then.",
			"Waits for the worker to finish before returning. Returns a text summary and a details.agent record.",
		],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String()),
			threadId: Type.Optional(Type.String()),
			prompt: Type.String(),
			model: Type.Optional(Type.String()),
			effort: Type.Optional(EffortSchema),
			template: Type.Optional(Type.String()),
			templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
			approvalPolicy: Type.Optional(ApprovalSchema),
			networkAccess: Type.Optional(Type.Boolean()),
			allowWrite: Type.Optional(Type.Boolean()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `codex_resume ${(args as any).agentId ?? (args as any).threadId ?? "thread"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "Resumed"), 0, 0);
		},
		async execute(_toolCallId, params, signal) {
			const agent = params.agentId
				? deps.registry.findAgent(params.agentId)
				: params.threadId
					? deps.registry.findAgent(params.threadId)
					: undefined;
			if (!agent?.threadId) {
				throw new Error("Unknown agent/thread. Provide an existing agentId or threadId from codex_list/codex_inspect.");
			}

			const notificationMode = (agent.notificationMode ?? "notify_each") as NotificationMode;
			const returnMode = "wait" as const;
			const approvalPolicy = (params.approvalPolicy ?? "never") as ApprovalPolicy;
			const networkAccess = params.networkAccess ?? false;
			const { templateName, prompt, templateDefaultModel, templateDefaultEffort } = buildPrompt(params, deps.templatesDir);
			const effort = (params.effort ?? templateDefaultEffort ?? agent.effort ?? "medium") as ReasoningEffort;
			const explicitModel = readOptionalModelId(params.model, "model");
			const inheritedModel = explicitModel || templateDefaultModel ? null : validateModelId(agent.model, `stored model for agent ${agent.id}`);
			const model = validateModelId(explicitModel ?? templateDefaultModel ?? inheritedModel ?? agent.model, explicitModel ? "model" : "resolved model");
			const allowWrite = params.allowWrite ?? ((templateName ?? params.template ?? agent.template ?? null) === "implement" ? true : (agent.allowWrite ?? false));

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
				notificationMode,
				returnMode,
				completionNotified: false,
				messages: agent.messages ?? [],
				historyHydratedAt: agent.historyHydratedAt ?? null,
			});

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
				});
				deps.registry.markThreadAttached(agent.id, { threadId: agent.threadId, activeTurnId: turn.turn.id });
				deps.registry.markTurnStarted(agent.threadId, turn.turn.id);
				deps.registry.appendUserMessage(agent.id, turn.turn.id, prompt);
			}

			const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
			return {
				content: [{ type: "text", text: truncateForDisplay(finalAgent.latestFinalOutput ?? finalAgent.latestSnippet, 400) || "Completed" }],
				details: { agent: finalAgent },
			};
		},
	});
}
