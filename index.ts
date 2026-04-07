import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CodexAppServerClient } from "./src/codex/app-server-client.js";
import { validateModelId } from "./src/codex/model-selection.js";
import type { CodexClientEvent } from "./src/codex/client.js";
import {
	DOE_PLAN_STATE_TYPE,
	clonePlanState,
	createEmptyPlanState,
	restoreLatestPlanState,
	serializePlanState,
	type DoePlanState,
} from "./src/plan/session-state.js";
import { runPlanReviewCli } from "./src/plan/review.js";
import { estimateCurrentTurnIndex, shouldInjectSessionSlugReminder } from "./src/plan/reminder.js";
import { IC_CONFIG } from "./src/roster/config.js";
import { DoeRegistry } from "./src/roster/registry.js";
import type { PersistedRegistrySnapshot, RegistryEvent } from "./src/roster/types.js";
import { AgentLiveViewController } from "./src/ui/agent-live-view.js";
import { formatDoeStatus } from "./src/ui/doe-status.js";
import { loadMarkdownDoc, loadMarkdownDocs, summarizeTemplates } from "./src/templates/loader.js";
import { registerPlanStartTool } from "./src/tools/plan-start.js";
import { registerPlanResumeTool } from "./src/tools/plan-resume.js";
import { registerPlanStopTool } from "./src/tools/plan-stop.js";
import { registerSessionSetTool } from "./src/tools/session-set.js";
import { registerSpawnTool } from "./src/tools/spawn.js";
import { registerResumeTool } from "./src/tools/resume.js";
import { registerListTool } from "./src/tools/list.js";
import { registerInspectTool } from "./src/tools/inspect.js";
import { registerCancelTool } from "./src/tools/cancel.js";
import { registerFinalizeTool } from "./src/tools/finalize.js";
import { ensureReadToolActive, evaluateReadGate } from "./src/read-gate.ts";

const DOE_FLAG = "doe";
const TOOL_NAMES = ensureReadToolActive([
	"session_set",
	"plan_start",
	"plan_resume",
	"plan_stop",
	"codex_spawn",
	"codex_delegate",
	"codex_resume",
	"codex_list",
	"codex_inspect",
	"codex_cancel",
	"codex_finalize",
]);
const DOE_MONITOR_SHORTCUT = "ctrl+,";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");
const TEMPLATES_DIR = join(__dirname, "templates");

interface DoeRuntime {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	planState: DoePlanState;
	liveView: AgentLiveViewController;
	latestCtx: ExtensionContext | null;
	persistTimer: ReturnType<typeof setTimeout> | null;
}

async function refreshThreadUsage(runtime: DoeRuntime, threadId: string, turnId: string | null = null) {
	try {
		const usage = await runtime.client.readContextWindowUsage(threadId, turnId);
		if (!usage) return;
		runtime.registry.markTokenUsage(threadId, turnId, usage);
	} catch {}
}

function primaryActiveAgent(registry: DoeRegistry) {
	return registry.listRosterAssignments()[0]?.agent ?? null;
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

export function formatCompactRosterSummary(): string {
	const grouped = new Map<string, string[]>();
	for (const ic of IC_CONFIG) {
		const names = grouped.get(ic.role) ?? [];
		names.push(ic.name);
		grouped.set(ic.role, names);
	}
	return `IC roster: ${Array.from(grouped.entries())
		.map(([role, names]) => `${role}: ${names.join(", ")}`)
		.join(" | ")}`;
}

export async function buildGuidanceMessage(): Promise<string> {
	const system = loadMarkdownDoc(join(PROMPTS_DIR, "doe-system.md"))?.body?.trim() ?? "";
	const decision = loadMarkdownDoc(join(PROMPTS_DIR, "decision-guidance.md"))?.body?.trim() ?? "";
	const roster = formatCompactRosterSummary();
	return [system, decision, roster].filter((part) => part.length > 0).join("\n\n");
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
		const liveView = new AgentLiveViewController(registry, client);
		runtime = {
			client,
			registry,
			planState: createEmptyPlanState(),
			liveView,
			latestCtx: ctx ?? null,
			persistTimer: null,
		};

		registry.on("event", handleRegistryEvent);
		client.on("event", handleCodexEvent);

		registerSessionSetTool(pi);
		registerPlanStartTool(pi, {
			client,
			registry,
			templatesDir: TEMPLATES_DIR,
			reviewPlan: runPlanReviewCli,
			getSessionSlug: () => pi.getSessionName() ?? null,
			getPlanState: () => clonePlanState(getRuntime().planState),
			setPlanState: updatePlanState,
		});
		registerPlanResumeTool(pi, {
			client,
			registry,
			templatesDir: TEMPLATES_DIR,
			reviewPlan: runPlanReviewCli,
			getSessionSlug: () => pi.getSessionName() ?? null,
			getPlanState: () => clonePlanState(getRuntime().planState),
			setPlanState: updatePlanState,
		});
		registerPlanStopTool(pi, {
			client,
			registry,
			getPlanState: () => clonePlanState(getRuntime().planState),
			setPlanState: updatePlanState,
		});
		registerSpawnTool(pi, {
			client,
			registry,
			templatesDir: TEMPLATES_DIR,
			getSessionSlug: () => pi.getSessionName() ?? null,
		});
		registerResumeTool(pi, {
			client,
			registry,
			templatesDir: TEMPLATES_DIR,
			getSessionSlug: () => pi.getSessionName() ?? null,
		});
		registerListTool(pi, { registry });
		registerInspectTool(pi, { client, registry });
		registerCancelTool(pi, { client, registry });
		registerFinalizeTool(pi, { registry });

		pi.registerShortcut(DOE_MONITOR_SHORTCUT, {
			description: "Open or close the Director of Engineering live monitor",
			handler: async (shortcutCtx) => {
				const activeRuntime = activate(shortcutCtx);
				if (!activeRuntime) {
					shortcutCtx.ui.notify("Director of Engineering mode is off. Start pi with --doe.", "warning");
					return;
				}
				activeRuntime.latestCtx = shortcutCtx;
				const agent = primaryActiveAgent(activeRuntime.registry);
				activeRuntime.liveView.toggle(shortcutCtx, agent ? { mode: "detail", agentId: agent.id } : { mode: "list" });
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
		pi.appendEntry(DOE_PLAN_STATE_TYPE, serializePlanState(runtime.planState));
	}

	function schedulePersist() {
		if (!runtime) return;
		if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
		runtime.persistTimer = setTimeout(() => {
			if (!runtime) return;
			runtime.persistTimer = null;
			pi.appendEntry("doe-registry", runtime.registry.serialize());
			pi.appendEntry(DOE_PLAN_STATE_TYPE, serializePlanState(runtime.planState));
		}, 5000);
	}

	function updatePlanState(
		updater: (state: DoePlanState) => DoePlanState,
		options: { flush?: boolean } = {},
	): DoePlanState {
		const activeRuntime = getRuntime();
		activeRuntime.planState = clonePlanState(updater(clonePlanState(activeRuntime.planState)));
		if (options.flush) {
			flushPersist();
		} else {
			schedulePersist();
		}
		return clonePlanState(activeRuntime.planState);
	}

	function updateUi(ctx: ExtensionContext) {
		if (!runtime || !ctx.hasUI) return;
		ctx.ui.setStatus("doe", ctx.ui.theme.fg("accent", formatDoeStatus(runtime.registry)));
		ctx.ui.setWidget("doe-active", undefined, { placement: "aboveEditor" });
		runtime.liveView.requestRender();
	}

	function buildPlanRevisionReminder() {
		return {
			customType: "doe-plan-revision-reminder",
			content: "Plan feedback is stored automatically. Call plan_resume with Director commentary only.",
			display: false,
		};
	}

	async function restoreState(ctx: ExtensionContext) {
		const activeRuntime = getRuntime();
		activeRuntime.planState = restoreLatestPlanState(ctx.sessionManager.getBranch());
		activeRuntime.registry.restore(latestSnapshot(ctx));
		const recoverableAgents = activeRuntime.registry.listRecoverableAgents();
		if (recoverableAgents.length > 0) {
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
			case "thread-token-usage":
				runtime.registry.markTokenUsage(event.threadId, event.turnId, event.usage);
				break;
			case "thread-compaction-started":
				runtime.registry.markCompactionStarted(event.threadId, { turnId: event.turnId, itemId: event.itemId });
				break;
			case "thread-compaction-completed":
				runtime.registry.markCompactionCompleted(event.threadId, {
					turnId: event.turnId,
					itemId: event.itemId,
					source: event.source,
				});
				void refreshThreadUsage(runtime, event.threadId, event.turnId);
				break;
			case "turn-started":
				runtime.registry.markTurnStarted(event.threadId, event.turnId);
				void refreshThreadUsage(runtime, event.threadId, event.turnId);
				break;
			case "agent-message-delta":
				runtime.registry.appendAgentMessageDelta(event.threadId, event.turnId, event.itemId, event.delta);
				break;
			case "agent-activity":
				runtime.registry.markActivity(event.threadId, event.activity);
				break;
			case "agent-message-complete":
				runtime.registry.completeAgentMessage(event.threadId, event.turnId, event.itemId, event.text);
				break;
			case "turn-completed":
				if (event.status === "completed") {
					runtime.registry.markCompleted(event.threadId, event.turnId, null);
				} else if (event.status === "failed") {
					runtime.registry.markError(event.threadId, event.error ?? "Codex turn failed.", event.turnId);
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
				if (event.thread?.id) {
					void refreshThreadUsage(runtime, event.thread.id, null);
				}
				break;
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
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const activeRuntime = activate(ctx);
		if (!activeRuntime) return;
		activeRuntime.latestCtx = ctx;
		applyToolSurface();
		await restoreState(ctx);
		updateUi(ctx);
	});

	pi.on("context", async (event, ctx) => {
		const activeRuntime = activate(ctx);
		if (!activeRuntime) return;
		const sessionSlug = pi.getSessionName() ?? null;
		const currentTurn = estimateCurrentTurnIndex(event.messages);
		const messages = [...event.messages];
		if (!shouldInjectSessionSlugReminder({
			sessionSlug,
			currentTurn,
			lastReminderTurn: activeRuntime.planState.sessionSlugReminderSentAtTurn,
		})) {
			// keep checking for a plan reminder below
		} else {
			updatePlanState(
				(current) => ({
					...current,
					sessionSlugReminderSentAtTurn: currentTurn,
				}),
				{ flush: true },
			);
			messages.push({
				customType: "doe-session-slug-reminder",
				content: "No canonical DoE session slug is set yet. Call session_set before planning or shared-workspace work. Pass one concise sessionSlug.",
				display: false,
			});
		}
		if (activeRuntime.planState.activePlan?.status === "needs_revision") {
			messages.push(buildPlanRevisionReminder());
		}
		if (messages.length === event.messages.length) return;
		return { messages };
	});

	pi.on("before_agent_start", async (_event) => {
		if (!isDoeEnabled()) return;
		activate();
		const guidance = await buildGuidanceMessage();
		return {
			systemPrompt: guidance,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isDoeEnabled()) return;
		if (!isToolCallEventType("read", event)) return;
		return evaluateReadGate({
			cwd: ctx.cwd,
			hasUI: ctx.hasUI,
			input: event.input,
			select: ctx.hasUI ? (title, options) => ctx.ui.select(title, options) : undefined,
			promptInput: ctx.hasUI ? (title, placeholder) => ctx.ui.input(title, placeholder) : undefined,
		});
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
