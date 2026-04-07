import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CodexAppServerClient,
	type PermissionApprovalRequest,
	type PermissionApprovalResult,
	type PermissionProfile,
} from "./codex/app-server-client.ts";
import type { CodexClientEvent } from "./codex/client.ts";
import { validateModelId } from "./codex/model-selection.ts";
import {
	clonePlanState,
	createEmptyPlanState,
	DOE_PLAN_STATE_TYPE,
	type DoePlanState,
	restoreLatestPlanState,
	serializePlanState,
} from "./plan/session-state.ts";
import { ensureReadToolActive } from "./read-gate.ts";
import { IC_CONFIG } from "./roster/config.ts";
import { DoeRegistry } from "./roster/registry.ts";
import type { PersistedRegistrySnapshot, RegistryEvent } from "./roster/types.ts";
import { loadMarkdownDoc } from "./templates/loader.ts";
import { AgentLiveViewController } from "./ui/agent-live-controller.ts";
import { formatDoeStatus } from "./ui/doe-status.ts";
import { isRecord } from "./utils/guards.ts";

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
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(ROOT_DIR, "..", "prompts");

export interface DoeRuntime {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	planState: DoePlanState;
	liveView: AgentLiveViewController;
	latestCtx: DoeExtensionContext | null;
	persistTimer: ReturnType<typeof setTimeout> | null;
}

export interface DoeUi {
	notify: (message: string, kind?: "info" | "warning" | "error") => void;
	setStatus: (name: string, value: string) => void;
	setWidget: (
		name: string,
		value: unknown,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => void;
	setWorkingMessage: (summary?: string) => void;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	requestRender: () => void;
	theme: { fg: (name: string, value: string) => string };
}

export interface DoeExtensionContext {
	cwd: string;
	hasUI: boolean;
	ui: DoeUi;
	sessionManager: {
		getBranch: () => unknown[];
	};
}

export interface DoeState {
	pi: ExtensionAPI;
	runtime: DoeRuntime | null;
}

function isDoeRegistrySnapshot(value: unknown): value is PersistedRegistrySnapshot {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.version === "number"
		&& typeof value.savedAt === "number"
		&& Array.isArray(value.agents)
		&& Array.isArray(value.batches)
	);
}

function latestSnapshot(ctx: DoeExtensionContext): PersistedRegistrySnapshot | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			isRecord(entry)
			&& entry.type === "custom"
			&& entry.customType === "doe-registry"
			&& isDoeRegistrySnapshot(entry.data)
		) {
			return entry.data;
		}
	}
	return null;
}

function getRuntime(state: DoeState): DoeRuntime {
	if (!state.runtime) {
		throw new Error("Director of Engineering mode is not active. Start pi with --doe.");
	}
	return state.runtime;
}

function summarizePathList(paths: string[] | null | undefined): string | null {
	if (paths === null) {
		return "none";
	}
	if (!paths || paths.length === 0) {
		return null;
	}
	return paths.join(", ");
}

function describePermissionRequest(permissions: PermissionProfile): string[] {
	const lines: string[] = [];
	const readPaths = summarizePathList(permissions.fileSystem?.read);
	const writePaths = summarizePathList(permissions.fileSystem?.write);
	const networkEnabled = permissions.network?.enabled;
	if (readPaths !== null) {
		lines.push(`filesystem read: ${readPaths}`);
	}
	if (writePaths !== null) {
		lines.push(`filesystem write: ${writePaths}`);
	}
	if (typeof networkEnabled === "boolean") {
		lines.push(`network: ${networkEnabled ? "enabled" : "disabled"}`);
	}
	return lines.length > 0 ? lines : ["(no additional permissions requested)"];
}

function resolveIcIdentity(runtime: DoeRuntime, threadId: string): string {
	const agent = runtime.registry.getAgentByThreadId(threadId);
	if (!agent) {
		return threadId || "unknown";
	}
	const seat = agent.seatName ?? agent.name ?? "unknown";
	return `${seat} (${agent.id})`;
}

async function requestDirectorPermissionApproval(
	runtime: DoeRuntime,
	request: PermissionApprovalRequest,
): Promise<PermissionApprovalResult> {
	const ctx = runtime.latestCtx;
	if (!ctx?.hasUI) {
		return { approved: false, scope: request.scope };
	}
	const titleLines = [
		"IC permission approval required.",
		`IC: ${resolveIcIdentity(runtime, request.threadId)}`,
		`Thread: ${request.threadId}`,
		...describePermissionRequest(request.permissions),
		...(request.reason ? [`Reason: ${request.reason}`] : []),
		`Scope: ${request.scope}`,
		"",
		"Approve this permission grant?",
	];
	const choice = await ctx.ui.select(titleLines.join("\n"), ["Yes", "No"]);
	if (choice !== "Yes") {
		return { approved: false, scope: request.scope };
	}
	return {
		approved: true,
		permissions: request.permissions,
		scope: request.scope,
	};
}

async function refreshThreadUsage(
	runtime: DoeRuntime,
	threadId: string,
	turnId: string | null = null,
) {
	try {
		const usage = await runtime.client.readContextWindowUsage(threadId, turnId);
		if (!usage) {
			return;
		}
		runtime.registry.markTokenUsage(threadId, turnId, usage);
	} catch (error) {
		console.error("[doe] Failed to refresh thread usage", error);
	}
}

function schedulePersist(state: DoeState) {
	const runtime = state.runtime;
	if (!runtime) {
		return;
	}
	if (runtime.persistTimer) {
		clearTimeout(runtime.persistTimer);
	}
	runtime.persistTimer = setTimeout(() => {
		const activeRuntime = state.runtime;
		if (!activeRuntime) {
			return;
		}
		activeRuntime.persistTimer = null;
		state.pi.appendEntry("doe-registry", activeRuntime.registry.serialize());
		state.pi.appendEntry(DOE_PLAN_STATE_TYPE, serializePlanState(activeRuntime.planState));
	}, 5000);
}

function handleRegistryEvent(state: DoeState, event: RegistryEvent) {
	const runtime = state.runtime;
	if (!runtime) {
		return;
	}
	if (event.type === "change") {
		schedulePersist(state);
		if (runtime.latestCtx) {
			updateUi(state, runtime.latestCtx);
		}
		return;
	}
	if (event.type === "agent-terminal" || event.type === "batch-completed") {
		flushPersist(state);
	}
}

function handleThreadStatusEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "thread-status" }>,
) {
	runtime.registry.markThreadStatus(event.threadId, event.status);
}

function handleThreadTokenUsageEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "thread-token-usage" }>,
) {
	runtime.registry.markTokenUsage(event.threadId, event.turnId, event.usage);
}

function handleThreadCompactionStartedEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "thread-compaction-started" }>,
) {
	runtime.registry.markCompactionStarted(event.threadId, {
		turnId: event.turnId,
		itemId: event.itemId,
	});
}

function handleThreadCompactionCompletedEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "thread-compaction-completed" }>,
) {
	runtime.registry.markCompactionCompleted(event.threadId, {
		turnId: event.turnId,
		itemId: event.itemId,
		source: event.source,
	});
	void refreshThreadUsage(runtime, event.threadId, event.turnId);
}

function handleTurnStartedEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "turn-started" }>,
) {
	runtime.registry.markTurnStarted(event.threadId, event.turnId);
	void refreshThreadUsage(runtime, event.threadId, event.turnId);
}

function handleAgentMessageDeltaEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "agent-message-delta" }>,
) {
	runtime.registry.appendAgentMessageDelta(
		event.threadId,
		event.turnId,
		event.itemId,
		event.delta,
	);
}

function handleAgentActivityEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "agent-activity" }>,
) {
	runtime.registry.markActivity(event.threadId, event.activity);
}

function handleAgentMessageCompleteEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "agent-message-complete" }>,
) {
	runtime.registry.completeAgentMessage(event.threadId, event.turnId, event.itemId, event.text);
}

function handleTurnCompletedEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "turn-completed" }>,
) {
	if (event.status === "completed") {
		runtime.registry.markCompleted(event.threadId, event.turnId, null);
		return;
	}
	if (event.status === "failed") {
		runtime.registry.markError(event.threadId, event.error ?? "Codex turn failed.", event.turnId);
		return;
	}
	runtime.registry.markAwaitingInput(
		event.threadId,
		event.error ?? `Turn ended with status: ${event.status}`,
	);
}

function handleErrorEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "error" }>,
) {
	if (!event.threadId) {
		return;
	}
	runtime.registry.markError(event.threadId, event.message);
}

function handleThreadStartedEvent(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: "thread-started" }>,
) {
	if (!event.thread?.id) {
		return;
	}
	void refreshThreadUsage(runtime, event.thread.id, null);
}

type CodexEventType = CodexClientEvent["type"];

type CodexEventHandlerMap = {
	[K in CodexEventType]: (
		runtime: DoeRuntime,
		event: Extract<CodexClientEvent, { type: K }>,
	) => void;
};

const CODEX_EVENT_HANDLERS: CodexEventHandlerMap = {
	"thread-status": handleThreadStatusEvent,
	"thread-token-usage": handleThreadTokenUsageEvent,
	"thread-compaction-started": handleThreadCompactionStartedEvent,
	"thread-compaction-completed": handleThreadCompactionCompletedEvent,
	"turn-started": handleTurnStartedEvent,
	"agent-message-delta": handleAgentMessageDeltaEvent,
	"agent-activity": handleAgentActivityEvent,
	"agent-message-complete": handleAgentMessageCompleteEvent,
	"turn-completed": handleTurnCompletedEvent,
	error: handleErrorEvent,
	"thread-started": handleThreadStartedEvent,
};

function dispatchCodexEvent<T extends CodexEventType>(
	runtime: DoeRuntime,
	event: Extract<CodexClientEvent, { type: T }>,
) {
	const handler = CODEX_EVENT_HANDLERS[event.type];
	handler(runtime, event);
}

function handleCodexEvent(state: DoeState, event: CodexClientEvent) {
	const runtime = state.runtime;
	if (!runtime) {
		return;
	}
	dispatchCodexEvent(runtime, event);
}

export function primaryActiveAgent(registry: DoeRegistry) {
	return registry.listRosterAssignments()[0]?.agent ?? null;
}

export function formatCompactRosterSummary(): string {
	const grouped = new Map<string, string[]>();
	for (const ic of IC_CONFIG) {
		const names = grouped.get(ic.role) ?? [];
		names.push(ic.name);
		grouped.set(ic.role, names);
	}
	return `IC roster: ${
		Array.from(grouped.entries())
			.map(([role, names]) => `${role}: ${names.join(", ")}`)
			.join(" | ")
	}`;
}

export function createDoeState(pi: ExtensionAPI): DoeState {
	return {
		pi,
		runtime: null,
	};
}

export function isDoeEnabled(state: DoeState): boolean {
	return Boolean(state.pi.getFlag(DOE_FLAG));
}

export function activate(state: DoeState, ctx?: DoeExtensionContext): DoeRuntime | null {
	if (!isDoeEnabled(state)) {
		return null;
	}
	if (state.runtime) {
		if (ctx) {
			state.runtime.latestCtx = ctx;
		}
		return state.runtime;
	}

	const client = new CodexAppServerClient({
		serviceName: "pi_doe",
		requestPermissionApproval: async (request) => {
			const activeRuntime = state.runtime;
			if (!activeRuntime) {
				return { approved: false, scope: request.scope };
			}
			return requestDirectorPermissionApproval(activeRuntime, request);
		},
	});
	const registry = new DoeRegistry();
	const liveView = new AgentLiveViewController(registry, client);
	const runtime: DoeRuntime = {
		client,
		registry,
		planState: createEmptyPlanState(),
		liveView,
		latestCtx: ctx ?? null,
		persistTimer: null,
	};
	state.runtime = runtime;

	registry.on("event", (event) => handleRegistryEvent(state, event));
	client.on("event", (event) => handleCodexEvent(state, event));
	return runtime;
}

export function applyToolSurface(state: DoeState) {
	if (!state.runtime) {
		return;
	}
	state.pi.setActiveTools(TOOL_NAMES);
}

export function flushPersist(state: DoeState) {
	const runtime = state.runtime;
	if (!runtime) {
		return;
	}
	if (runtime.persistTimer) {
		clearTimeout(runtime.persistTimer);
		runtime.persistTimer = null;
	}
	state.pi.appendEntry("doe-registry", runtime.registry.serialize());
	state.pi.appendEntry(DOE_PLAN_STATE_TYPE, serializePlanState(runtime.planState));
}

export function updatePlanState(
	state: DoeState,
	updater: (state: DoePlanState) => DoePlanState,
	options: { flush?: boolean } = {},
): DoePlanState {
	const runtime = getRuntime(state);
	runtime.planState = clonePlanState(updater(clonePlanState(runtime.planState)));
	if (options.flush) {
		flushPersist(state);
		return clonePlanState(runtime.planState);
	}
	schedulePersist(state);
	return clonePlanState(runtime.planState);
}

export function updateUi(state: DoeState, ctx: DoeExtensionContext) {
	const runtime = state.runtime;
	if (!runtime || !ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus("doe", ctx.ui.theme.fg("accent", formatDoeStatus(runtime.registry)));
	ctx.ui.setWidget("doe-active", undefined, { placement: "aboveEditor" });
	runtime.liveView.requestRender();
}

export async function buildGuidanceMessage(): Promise<string> {
	const system = loadMarkdownDoc(join(PROMPTS_DIR, "doe-system.md"))?.body?.trim() ?? "";
	const decision = loadMarkdownDoc(join(PROMPTS_DIR, "decision-guidance.md"))?.body?.trim() ?? "";
	const roster = formatCompactRosterSummary();
	return [system, decision, roster].filter((part) => part.length > 0).join("\n\n");
}

export async function restoreState(state: DoeState, ctx: DoeExtensionContext) {
	const runtime = getRuntime(state);
	runtime.planState = restoreLatestPlanState(ctx.sessionManager.getBranch());
	runtime.registry.restore(latestSnapshot(ctx));
	const recoverableAgents = runtime.registry.listRecoverableAgents();
	if (recoverableAgents.length === 0) {
		return;
	}
	await runtime.client.ensureStarted();
	for (const agent of recoverableAgents) {
		const threadId = agent.threadId;
		if (!threadId) {
			continue;
		}
		try {
			const model = validateModelId(agent.model, `stored model for agent ${agent.id}`);
			await runtime.client.resumeThread({
				threadId,
				cwd: agent.cwd,
				model,
				allowWrite: agent.allowWrite ?? false,
			});
			runtime.registry.markThreadAttached(agent.id, {
				threadId,
				recovered: true,
			});
		} catch (error) {
			runtime.registry.markError(
				threadId,
				`Failed to rehydrate thread: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
