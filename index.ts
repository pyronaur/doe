import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { CodexAppServerClient } from "./src/codex/app-server-client.js";
import type { CodexClientEvent } from "./src/codex/client.js";
import { truncateForDisplay } from "./src/codex/client.js";
import { SysopRegistry, type AgentRecord, type BatchRecord, type PersistedRegistrySnapshot, type RegistryEvent } from "./src/state/registry.js";
import { AgentSidebarController } from "./src/ui/agent-sidebar.js";
import { loadMarkdownDoc, loadMarkdownDocs, summarizeTemplates } from "./src/templates/loader.js";
import { registerSpawnTool } from "./src/tools/spawn.js";
import { registerResumeTool } from "./src/tools/resume.js";
import { registerListTool } from "./src/tools/list.js";
import { registerInspectTool } from "./src/tools/inspect.js";
import { registerCancelTool } from "./src/tools/cancel.js";
import { registerDocsTool } from "./src/tools/docs.js";

const TOOL_NAMES = ["read", "docs", "codex_spawn", "codex_delegate", "codex_resume", "codex_list", "codex_inspect", "codex_cancel"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");
const TEMPLATES_DIR = join(__dirname, "templates");

function formatActiveSummary(registry: SysopRegistry): string[] {
	const agents = registry.listAgents({ includeCompleted: false, limit: 3 });
	if (agents.length === 0) return [];
	return agents.map((agent) => `• ${agent.name} [${agent.state}] ${truncateForDisplay(agent.latestSnippet, 42)}`);
}

function latestSnapshot(ctx: ExtensionContext): PersistedRegistrySnapshot | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type === "custom" && entry?.customType === "sysop-registry") {
			return entry.data as PersistedRegistrySnapshot;
		}
	}
	return null;
}

function buildAgentNotification(agent: AgentRecord): string {
	const headline = `${agent.name} [${agent.state}] ${agent.model}`;
	const detail = (agent.latestFinalOutput ?? agent.latestSnippet) || "No summary available.";
	return `${headline}\n${detail}`;
}

function buildBatchNotification(batch: BatchRecord, agents: AgentRecord[]): string {
	const lines = [`Batch complete: ${batch.name}`];
	for (const agent of agents) {
		lines.push(`- ${agent.name} [${agent.state}] ${truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, 160)}`);
	}
	return lines.join("\n");
}

export default function sysopExtension(pi: ExtensionAPI) {
	const client = new CodexAppServerClient({ serviceName: "pi_sysop" });
	const registry = new SysopRegistry();
	const sidebar = new AgentSidebarController(registry);
	let latestCtx: ExtensionContext | null = null;
	let persistTimer: ReturnType<typeof setTimeout> | null = null;

	function applyToolSurface() {
		pi.setActiveTools(TOOL_NAMES);
	}

	function flushPersist() {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		pi.appendEntry("sysop-registry", registry.serialize());
	}

	function schedulePersist() {
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			persistTimer = null;
			pi.appendEntry("sysop-registry", registry.serialize());
		}, 5000);
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const active = registry.listAgents({ includeCompleted: false }).length;
		ctx.ui.setStatus("sysop", ctx.ui.theme.fg("accent", `🧭 sysop ${active} active`));
		const summary = formatActiveSummary(registry);
		ctx.ui.setWidget("sysop-active", summary.length > 0 ? summary : undefined, { placement: "belowEditor" });
		sidebar.requestRender();
	}

	async function buildGuidanceMessage(): Promise<string> {
		const system = loadMarkdownDoc(join(PROMPTS_DIR, "sysop-system.md"))?.body ?? "";
		const decision = loadMarkdownDoc(join(PROMPTS_DIR, "decision-guidance.md"))?.body ?? "";
		const templates = summarizeTemplates(loadMarkdownDocs(TEMPLATES_DIR));
		return [
			"[SYSOP ORCHESTRATION MODE]",
			system,
			"",
			decision,
			"",
			"Installed templates:",
			templates,
			"",
			`Active tools: ${TOOL_NAMES.join(", ")}`,
		].join("\n");
	}

	async function restoreState(ctx: ExtensionContext) {
		registry.restore(latestSnapshot(ctx));
		const recoverableAgents = registry
			.listAgents({ includeCompleted: true })
			.filter((agent) => agent.threadId && (agent.state === "working" || agent.state === "awaiting_input"));
		if (recoverableAgents.length === 0) return;
		await client.ensureStarted();
		for (const agent of recoverableAgents) {
			try {
				await client.resumeThread({ threadId: agent.threadId!, cwd: agent.cwd, model: agent.model, allowWrite: agent.allowWrite ?? false });
				registry.markThreadAttached(agent.id, { threadId: agent.threadId!, recovered: true });
			} catch (error) {
				registry.markError(agent.threadId!, `Failed to rehydrate thread: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	function handleRegistryEvent(event: RegistryEvent) {
		if (event.type === "change") {
			schedulePersist();
			if (latestCtx) updateUi(latestCtx);
			return;
		}

		if (event.type === "agent-terminal") {
			flushPersist();
			const agent = event.agent;
			if (agent.returnMode === "async" && agent.notificationMode === "notify_each" && !agent.completionNotified) {
				pi.sendMessage(
					{
						customType: "sysop-notification",
						content: buildAgentNotification(agent),
						details: { kind: "agent", agent },
						display: true,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				registry.markCompletionNotified(agent.id);
			}
			return;
		}

		if (event.type === "batch-completed") {
			flushPersist();
			const batch = event.batch;
			if (batch.returnMode === "async" && batch.notificationMode === "wait_all" && !batch.notified) {
				pi.sendMessage(
					{
						customType: "sysop-notification",
						content: buildBatchNotification(batch, event.agents),
						details: { kind: "batch", batch, agents: event.agents },
						display: true,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				registry.markBatchNotified(batch.id);
			}
		}
	}

	function handleCodexEvent(event: CodexClientEvent) {
		switch (event.type) {
			case "thread-status":
				registry.markThreadStatus(event.threadId, event.status);
				break;
			case "turn-started":
				registry.markTurnStarted(event.threadId, event.turnId);
				break;
			case "agent-message-delta":
				registry.appendAgentDelta(event.threadId, event.delta);
				break;
			case "agent-message-complete":
				registry.setAgentSnippet(event.threadId, event.text);
				break;
			case "turn-completed":
				if (event.status === "completed") {
					registry.markCompleted(event.threadId);
				} else if (event.status === "failed") {
					registry.markError(event.threadId, event.error ?? "Codex turn failed.");
				} else {
					registry.markAwaitingInput(event.threadId, event.error ?? `Turn ended with status: ${event.status}`);
				}
				break;
			case "error":
				if (event.threadId) {
					registry.markError(event.threadId, event.message);
				}
				break;
			case "thread-started":
			default:
				break;
		}
	}

	registry.on("event", handleRegistryEvent);
	client.on("event", handleCodexEvent);

	pi.registerMessageRenderer("sysop-notification", (message, _options, theme) => {
		const details = (message as any).details ?? {};
		const prefix = details.kind === "batch" ? "batch" : "agent";
		return new Text(theme.fg("accent", `[sysop/${prefix}] `) + String(message.content ?? ""), 0, 0);
	});

	registerSpawnTool(pi, { client, registry, templatesDir: TEMPLATES_DIR });
	registerResumeTool(pi, { client, registry, templatesDir: TEMPLATES_DIR });
	registerListTool(pi, { registry });
	registerInspectTool(pi, { client, registry });
	registerCancelTool(pi, { client, registry });
	registerDocsTool(pi);

	pi.registerCommand("sysop-sidebar", {
		description: "Toggle the persistent sysop sidebar",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			sidebar.open(ctx);
			sidebar.toggle();
		},
	});

	pi.registerCommand("sysop-templates", {
		description: "Show installed sysop templates",
		handler: async (_args, ctx) => {
			const text = summarizeTemplates(loadMarkdownDocs(TEMPLATES_DIR));
			ctx.ui.notify(text, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		applyToolSurface();
		await restoreState(ctx);
		sidebar.open(ctx);
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		latestCtx = ctx;
		applyToolSurface();
		await restoreState(ctx);
		sidebar.open(ctx);
		updateUi(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const guidance = await buildGuidanceMessage();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		flushPersist();
		if (!ctx.hasUI) {
			client.close();
		}
	});

	process.on("exit", () => client.close());
}
