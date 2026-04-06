import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import { truncateForDisplay, type ApprovalPolicy, type ReasoningEffort } from "../codex/client.js";
import type { NotificationMode, SysopRegistry } from "../state/registry.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);

interface ResumeToolDeps {
	client: CodexAppServerClient;
	registry: SysopRegistry;
	templatesDir: string;
}

function buildPrompt(params: any, templatesDir: string): { templateName: string | null; prompt: string } {
	if (!params.template) {
		return { templateName: null, prompt: params.prompt };
	}
	const docs = loadMarkdownDocs(templatesDir);
	const doc = docs.find((entry) => entry.name === params.template);
	if (!doc) throw new Error(`Unknown template \"${params.template}\".`);
	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const rendered = renderMarkdownTemplate(doc, { task: params.prompt, ...(params.templateVariables ?? {}) }).trim();
	return {
		templateName: doc.name,
		prompt: usesTaskPlaceholder || !params.prompt ? rendered : `${rendered}\n\n# Task\n${params.prompt}`,
	};
}

export function registerResumeTool(pi: ExtensionAPI, deps: ResumeToolDeps) {
	pi.registerTool({
		name: "codex_resume",
		label: "Codex Resume",
		description: "Resume or steer an existing Codex workstream.",
		promptSnippet: "Resume a related Codex thread instead of spawning a fresh one when the workstream is still relevant.",
		promptGuidelines: [
			"Use this when continuing related work on an existing thread.",
			"If the request is unrelated, prefer codex_spawn for a fresh thread.",
			"This tool waits for the resumed worker to finish before returning.",
			"Keep the thread read-only unless this is explicit implementation work.",
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
			const effort = (params.effort ?? agent.effort ?? "medium") as ReasoningEffort;
			const model = params.model ?? agent.model;
			const approvalPolicy = (params.approvalPolicy ?? "never") as ApprovalPolicy;
			const networkAccess = params.networkAccess ?? false;
			const { templateName, prompt } = buildPrompt(params, deps.templatesDir);
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
			}

			const finalAgent = await deps.registry.waitForAgent(agent.id, signal);
			return {
				content: [{ type: "text", text: truncateForDisplay(finalAgent.latestFinalOutput ?? finalAgent.latestSnippet, 400) || "Completed" }],
				details: { agent: finalAgent },
			};
		},
	});
}
