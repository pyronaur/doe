import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CodexAppServerClient } from "./src/codex/app-server-client.js";
import { validateModelId } from "./src/codex/model-selection.js";
import type { CodexClientEvent } from "./src/codex/client.js";
import { DoeRegistry, type PersistedRegistrySnapshot, type RegistryEvent } from "./src/state/registry.js";
import { AgentSidebarController } from "./src/ui/agent-sidebar.js";
import { loadMarkdownDoc, loadMarkdownDocs, summarizeTemplates } from "./src/templates/loader.js";
import { registerSpawnTool } from "./src/tools/spawn.js";
import { registerResumeTool } from "./src/tools/resume.js";
import { registerListTool } from "./src/tools/list.js";
import { registerInspectTool } from "./src/tools/inspect.js";
import { registerCancelTool } from "./src/tools/cancel.js";

const DOE_FLAG = "doe";
const TOOL_NAMES = ["codex_spawn", "codex_delegate", "codex_resume", "codex_list", "codex_inspect", "codex_cancel"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");
const TEMPLATES_DIR = join(__dirname, "templates");

interface DoeRuntime {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	sidebar: AgentSidebarController;
	latestCtx: ExtensionContext | null;
	persistTimer: ReturnType<typeof setTimeout> | null;
}

function formatActiveSummary(registry: DoeRegistry): string[] {
	const agents = registry.listAgents({ includeCompleted: false, limit: 3 });
	if (agents.length === 0) return [];
	return agents.map((agent) => `• ${agent.name}: ${agent.activityLabel ?? agent.state}`);
}

function latestSnapshot(ctx: ExtensionContext): PersistedRegistrySnapshot | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry?.type === "custom" && entry?.customType === "doe-registry") {
			return entry.data as PersistedRegistrySnapshot;
		}
	}
	return null;
}

export default function doeExtension(pi: ExtensionAPI) {
	pi.registerFlag(DOE_FLAG, {
		description: "Activate Director of Engineering mode",
		type: "boolean",
		default: false,
	});

	let runtime: DoeRuntime | null = null;

	function isDoeEnabled(): boolean {
		return Boolean(pi.getFlag(DOE_FLAG));
	}

	function getRuntime(): DoeRuntime {
		if (!runtime) {
			throw new Error("Director of Engineering mode is not active. Start pi with --doe.");
		}
		return runtime;
	}

	function activate(ctx?: ExtensionContext): DoeRuntime | null {
		if (!isDoeEnabled()) return null;
		if (runtime) {
			if (ctx) runtime.latestCtx = ctx;
			return runtime;
		}

		const client = new CodexAppServerClient({ serviceName: "pi_doe" });
		const registry = new DoeRegistry();
		const sidebar = new AgentSidebarController(registry);
		runtime = {
			client,
			registry,
			sidebar,
			latestCtx: ctx ?? null,
			persistTimer: null,
		};

		registry.on("event", handleRegistryEvent);
		client.on("event", handleCodexEvent);

		registerSpawnTool(pi, { client, registry, templatesDir: TEMPLATES_DIR });
		registerResumeTool(pi, { client, registry, templatesDir: TEMPLATES_DIR });
		registerListTool(pi, { registry });
		registerInspectTool(pi, { client, registry });
		registerCancelTool(pi, { client, registry });

		pi.registerCommand("doe-sidebar", {
			description: "Toggle the persistent Director of Engineering sidebar",
			handler: async (_args, commandCtx) => {
				const activeRuntime = activate(commandCtx);
				if (!activeRuntime) {
					commandCtx.ui.notify("Director of Engineering mode is off. Start pi with --doe.", "warning");
					return;
				}
				activeRuntime.latestCtx = commandCtx;
				activeRuntime.sidebar.open(commandCtx);
				activeRuntime.sidebar.toggle();
			},
		});

		pi.registerCommand("doe-templates", {
			description: "Show installed Director of Engineering templates",
			handler: async (_args, commandCtx) => {
				if (!activate(commandCtx)) {
					commandCtx.ui.notify("Director of Engineering mode is off. Start pi with --doe.", "warning");
					return;
				}
				const text = summarizeTemplates(loadMarkdownDocs(TEMPLATES_DIR));
				commandCtx.ui.notify(text, "info");
			},
		});

		return runtime;
	}

	function applyToolSurface() {
		if (!runtime) return;
		pi.setActiveTools(TOOL_NAMES);
	}

	function flushPersist() {
		if (!runtime) return;
		if (runtime.persistTimer) {
			clearTimeout(runtime.persistTimer);
			runtime.persistTimer = null;
		}
		pi.appendEntry("doe-registry", runtime.registry.serialize());
	}

	function schedulePersist() {
		if (!runtime) return;
		if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
		runtime.persistTimer = setTimeout(() => {
			if (!runtime) return;
			runtime.persistTimer = null;
			pi.appendEntry("doe-registry", runtime.registry.serialize());
		}, 5000);
	}

	function updateUi(ctx: ExtensionContext) {
		if (!runtime || !ctx.hasUI) return;
		const active = runtime.registry.listAgents({ includeCompleted: false }).length;
		ctx.ui.setStatus("doe", ctx.ui.theme.fg("accent", `🧭 DoE ${active} active`));
		const summary = formatActiveSummary(runtime.registry);
		ctx.ui.setWidget("doe-active", summary.length > 0 ? summary : undefined, { placement: "belowEditor" });
		runtime.sidebar.requestRender();
	}

	async function buildGuidanceMessage(): Promise<string> {
		const system = loadMarkdownDoc(join(PROMPTS_DIR, "doe-system.md"))?.body?.trim() ?? "";
		const decision = loadMarkdownDoc(join(PROMPTS_DIR, "decision-guidance.md"))?.body?.trim() ?? "";
		return [system, decision].filter((part) => part.length > 0).join("\n\n");
	}

	async function restoreState(ctx: ExtensionContext) {
		const activeRuntime = getRuntime();
		activeRuntime.registry.restore(latestSnapshot(ctx));
		const recoverableAgents = activeRuntime.registry
			.listAgents({ includeCompleted: true })
			.filter((agent) => agent.threadId && (agent.state === "working" || agent.state === "awaiting_input"));
		if (recoverableAgents.length === 0) return;
		await activeRuntime.client.ensureStarted();
		for (const agent of recoverableAgents) {
			try {
				const model = validateModelId(agent.model, `stored model for agent ${agent.id}`);
				await activeRuntime.client.resumeThread({ threadId: agent.threadId!, cwd: agent.cwd, model, allowWrite: agent.allowWrite ?? false });
				activeRuntime.registry.markThreadAttached(agent.id, { threadId: agent.threadId!, recovered: true });
			} catch (error) {
				activeRuntime.registry.markError(agent.threadId!, `Failed to rehydrate thread: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	function handleRegistryEvent(event: RegistryEvent) {
		if (!runtime) return;
		if (event.type === "change") {
			schedulePersist();
			if (runtime.latestCtx) updateUi(runtime.latestCtx);
			return;
		}

		if (event.type === "agent-terminal" || event.type === "batch-completed") {
			flushPersist();
		}
	}

	function handleCodexEvent(event: CodexClientEvent) {
		if (!runtime) return;
		switch (event.type) {
			case "thread-status":
				runtime.registry.markThreadStatus(event.threadId, event.status);
				break;
			case "turn-started":
				runtime.registry.markTurnStarted(event.threadId, event.turnId);
				break;
			case "agent-message-delta":
				runtime.registry.appendAgentDelta(event.threadId, event.delta);
				break;
			case "agent-activity":
				runtime.registry.markActivity(event.threadId, event.activity);
				break;
			case "agent-message-complete":
				runtime.registry.setAgentSnippet(event.threadId, event.text);
				break;
			case "turn-completed":
				if (event.status === "completed") {
					runtime.registry.markCompleted(event.threadId);
				} else if (event.status === "failed") {
					runtime.registry.markError(event.threadId, event.error ?? "Codex turn failed.");
				} else {
					runtime.registry.markAwaitingInput(event.threadId, event.error ?? `Turn ended with status: ${event.status}`);
				}
				break;
			case "error":
				if (event.threadId) {
					runtime.registry.markError(event.threadId, event.message);
				}
				break;
			case "thread-started":
			default:
				break;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const activeRuntime = activate(ctx);
		if (!activeRuntime) return;
		activeRuntime.latestCtx = ctx;
		applyToolSurface();
		await restoreState(ctx);
		activeRuntime.sidebar.open(ctx);
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const activeRuntime = activate(ctx);
		if (!activeRuntime) return;
		activeRuntime.latestCtx = ctx;
		applyToolSurface();
		await restoreState(ctx);
		activeRuntime.sidebar.open(ctx);
		updateUi(ctx);
	});

	pi.on("before_agent_start", async (_event) => {
		if (!isDoeEnabled()) return;
		activate();
		const guidance = await buildGuidanceMessage();
		return {
			systemPrompt: guidance,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!runtime) return;
		flushPersist();
		if (!ctx.hasUI) {
			runtime.client.close();
		}
	});

	pi.on("session_shutdown", async () => {
		if (!runtime) return;
		flushPersist();
		runtime.client.close();
	});

	process.on("exit", () => runtime?.client.close());
}
