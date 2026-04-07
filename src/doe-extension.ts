import { type ExtensionAPI, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	activate,
	applyToolSurface,
	buildGuidanceMessage,
	createDoeState,
	flushPersist,
	primaryActiveAgent,
	restoreState,
	updatePlanState,
	updateUi,
} from "./doe-core.ts";
import type { DoeExtensionContext } from "./doe-core.ts";
import { estimateCurrentTurnIndex, shouldInjectSessionSlugReminder } from "./plan/reminder.ts";
import { startPlanReviewCli } from "./plan/review.ts";
import { clonePlanState } from "./plan/session-state.ts";
import { evaluateReadGate } from "./read-gate.ts";
import { loadMarkdownDocs, summarizeTemplates } from "./templates/loader.ts";
import { registerCancelTool } from "./tools/cancel.ts";
import { registerFinalizeTool } from "./tools/finalize.ts";
import { registerInspectTool } from "./tools/inspect.ts";
import { registerListTool } from "./tools/list.ts";
import { registerPlanResumeTool } from "./tools/plan-resume.ts";
import { registerPlanStartTool } from "./tools/plan-start.ts";
import { registerPlanStopTool } from "./tools/plan-stop.ts";
import { registerResumeTool } from "./tools/resume.ts";
import { registerSessionSetTool } from "./tools/session-set.ts";
import { registerSpawnTool } from "./tools/spawn.ts";

const DOE_FLAG = "doe";
const DOE_MONITOR_SHORTCUT = "ctrl+,";
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(ROOT_DIR, "..");
const TEMPLATES_DIR = join(PROJECT_DIR, "templates");
let runtimeToolsRegistered = false;

function registerRuntimeTools(
	state: ReturnType<typeof createDoeState>,
	runtime: NonNullable<ReturnType<typeof createDoeState>["runtime"]>,
) {
	const getSessionSlug = () => state.pi.getSessionName() ?? null;
	const getPlanState = () => clonePlanState(runtime.planState);
	const updatePlan = (
		updater: (state: typeof runtime.planState) => typeof runtime.planState,
		options?: { flush?: boolean },
	) => updatePlanState(state, updater, options);
	const planToolDeps = {
		client: runtime.client,
		registry: runtime.registry,
		templatesDir: TEMPLATES_DIR,
		startReviewPlan: startPlanReviewCli,
		getSessionSlug,
		getPlanState,
		setPlanState: updatePlan,
	};

	registerSessionSetTool(state.pi);
	registerPlanStartTool(state.pi, planToolDeps);
	registerPlanResumeTool(state.pi, planToolDeps);
	registerPlanStopTool(state.pi, {
		client: runtime.client,
		registry: runtime.registry,
		getPlanState,
		setPlanState: updatePlan,
	});
	registerSpawnTool(state.pi, {
		client: runtime.client,
		registry: runtime.registry,
		templatesDir: TEMPLATES_DIR,
		getSessionSlug,
	});
	registerResumeTool(state.pi, {
		client: runtime.client,
		registry: runtime.registry,
		templatesDir: TEMPLATES_DIR,
		getSessionSlug,
	});
	registerListTool(state.pi, { registry: runtime.registry });
	registerInspectTool(state.pi, { client: runtime.client, registry: runtime.registry });
	registerCancelTool(state.pi, { client: runtime.client, registry: runtime.registry });
	registerFinalizeTool(state.pi, { registry: runtime.registry });
}

function ensureRuntimeTools(
	state: ReturnType<typeof createDoeState>,
	runtime: NonNullable<ReturnType<typeof createDoeState>["runtime"]>,
) {
	if (runtimeToolsRegistered) {
		return;
	}
	runtimeToolsRegistered = true;
	registerRuntimeTools(state, runtime);
}

function activateRuntime(
	state: ReturnType<typeof createDoeState>,
	ctx?: DoeExtensionContext,
) {
	const runtime = activate(state, ctx);
	if (!runtime) {
		return null;
	}
	ensureRuntimeTools(state, runtime);
	return runtime;
}

function buildPlanRevisionReminder() {
	return {
		customType: "doe-plan-revision-reminder",
		content:
			"Plan feedback is stored automatically. Call plan_resume with Director commentary only.",
		display: false,
	};
}

function registerDoeUiHandlers(state: ReturnType<typeof createDoeState>) {
	const { pi } = state;
	pi.registerShortcut(DOE_MONITOR_SHORTCUT, {
		description: "Open or close the Director of Engineering live monitor",
		handler: async (shortcutCtx) => {
			const activeRuntime = activateRuntime(state, shortcutCtx);
			if (!activeRuntime) {
				shortcutCtx.ui.notify(
					"Director of Engineering mode is off. Start pi with --doe.",
					"warning",
				);
				return;
			}
			const agent = primaryActiveAgent(activeRuntime.registry);
			activeRuntime.liveView.toggle(
				shortcutCtx,
				agent ? { mode: "detail", agentId: agent.id } : { mode: "list" },
			);
		},
	});

	pi.registerCommand("doe-templates", {
		description: "Show installed Director of Engineering templates",
		handler: async (_args, commandCtx) => {
			if (!activateRuntime(state, commandCtx)) {
				commandCtx.ui.notify(
					"Director of Engineering mode is off. Start pi with --doe.",
					"warning",
				);
				return;
			}
			const text = summarizeTemplates(loadMarkdownDocs(TEMPLATES_DIR));
			commandCtx.ui.notify(text, "info");
		},
	});
}

function registerDoeSessionHandlers(state: ReturnType<typeof createDoeState>) {
	const { pi } = state;
	const restoreSessionContext = async (ctx: DoeExtensionContext) => {
		const activeRuntime = activateRuntime(state, ctx);
		if (!activeRuntime) {
			return;
		}
		applyToolSurface(state);
		await restoreState(state, ctx);
		updateUi(state, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		await restoreSessionContext(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreSessionContext(ctx);
	});

	pi.on("context", async (event, ctx) => {
		const activeRuntime = activateRuntime(state, ctx);
		if (!activeRuntime) {
			return;
		}
		const sessionSlug = pi.getSessionName() ?? null;
		const currentTurn = estimateCurrentTurnIndex(event.messages);
		const messages = [...event.messages];
		if (
			shouldInjectSessionSlugReminder({
				sessionSlug,
				currentTurn,
				lastReminderTurn: activeRuntime.planState.sessionSlugReminderSentAtTurn,
			})
		) {
			updatePlanState(
				state,
				(current) => ({
					...current,
					sessionSlugReminderSentAtTurn: currentTurn,
				}),
				{ flush: true },
			);
			messages.push({
				customType: "doe-session-slug-reminder",
				content:
					"No canonical DoE session slug is set yet. Call session_set before planning or shared-workspace work. Pass one concise sessionSlug.",
				display: false,
			});
		}
		if (activeRuntime.planState.activePlan?.status === "needs_revision") {
			messages.push(buildPlanRevisionReminder());
		}
		if (messages.length === event.messages.length) {
			return;
		}
		return { messages };
	});
}

function registerDoeRuntimeHandlers(state: ReturnType<typeof createDoeState>) {
	const { pi } = state;
	pi.on("before_agent_start", async (_event) => {
		const activeRuntime = activateRuntime(state);
		if (!activeRuntime) {
			return;
		}
		const guidance = await buildGuidanceMessage();
		return {
			systemPrompt: guidance,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.pi.getFlag(DOE_FLAG)) {
			return;
		}
		if (!isToolCallEventType("read", event)) {
			return;
		}
		return evaluateReadGate({
			cwd: ctx.cwd,
			hasUI: ctx.hasUI,
			input: event.input,
			select: ctx.hasUI ? (title, options) => ctx.ui.select(title, options) : undefined,
			promptInput: ctx.hasUI ? (title, placeholder) => ctx.ui.input(title, placeholder) : undefined,
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		const runtime = state.runtime;
		if (!runtime) {
			return;
		}
		flushPersist(state);
		if (!ctx.hasUI) {
			runtime.client.close();
		}
	});

	pi.on("session_shutdown", async () => {
		const runtime = state.runtime;
		if (!runtime) {
			return;
		}
		flushPersist(state);
		runtime.client.close();
	});

	process.on("exit", () => state.runtime?.client.close());
}

export function registerDoeExtension(pi: ExtensionAPI) {
	const state = createDoeState(pi);
	pi.registerFlag(DOE_FLAG, {
		description: "Activate Director of Engineering mode",
		type: "boolean",
		default: false,
	});
	registerDoeUiHandlers(state);
	registerDoeSessionHandlers(state);
	registerDoeRuntimeHandlers(state);
}
