import type { AgentActivity, ReasoningEffort } from "../codex/client.js";
import type { AgentCompactionState, AgentUsageSnapshot } from "../context-usage.js";

export type AgentLifecycleState = "working" | "completed" | "error" | "awaiting_input" | "finalized";
export type NotificationMode = "wait_all" | "notify_each";
export type ReturnMode = "wait";
export type ICRole = "senior" | "mid" | "research";
export type SeatRole = ICRole | "contractor";

export interface ICDefaults {
	model: string;
	effort?: ReasoningEffort;
	allowWrite?: boolean;
}

export interface ICConfig {
	name: string;
	role: ICRole;
	defaults: ICDefaults;
}

export interface AgentMessageRecord {
	turnId: string;
	itemId: string | null;
	role: "user" | "agent";
	text: string;
	streaming: boolean;
	createdAt: number;
	completedAt?: number | null;
}

export interface AgentRecord {
	id: string;
	name: string;
	cwd: string;
	model: string;
	effort?: string;
	template?: string | null;
	allowWrite?: boolean;
	threadId?: string | null;
	activeTurnId?: string | null;
	state: AgentLifecycleState;
	activityLabel?: AgentActivity | null;
	latestSnippet: string;
	latestFinalOutput?: string | null;
	lastError?: string | null;
	usage?: AgentUsageSnapshot | null;
	compaction?: AgentCompactionState | null;
	startedAt: number;
	runStartedAt?: number | null;
	completedAt?: number | null;
	interruptedTurnId?: string | null;
	parentBatchId?: string | null;
	notificationMode: NotificationMode;
	returnMode: ReturnMode;
	completionNotified?: boolean;
	recovered?: boolean;
	seatName?: string | null;
	seatRole?: SeatRole | null;
	finishNote?: string | null;
	reuseSummary?: string | null;
	messages: AgentMessageRecord[];
	historyHydratedAt?: number | null;
}

export interface BatchRecord {
	id: string;
	name: string;
	agentIds: string[];
	notificationMode: NotificationMode;
	returnMode: ReturnMode;
	startedAt: number;
	completedAt?: number | null;
	notified?: boolean;
}

export interface RosterSeatRecord {
	name: string;
	role: SeatRole;
	model: string;
	activeAgentId?: string | null;
	lastFinishedAgentId?: string | null;
	lastThreadId?: string | null;
	lastFinishNote?: string | null;
	lastReuseSummary?: string | null;
}

export interface PersistedRosterSnapshot {
	seats: RosterSeatRecord[];
	nextContractorNumber: number;
}

export interface PersistedRegistrySnapshot {
	version: number;
	savedAt: number;
	agents: AgentRecord[];
	batches: BatchRecord[];
	roster?: PersistedRosterSnapshot | null;
}

export interface RosterAssignmentRecord {
	seat: RosterSeatRecord;
	agent: AgentRecord;
	source: "active" | "history";
}

export interface RosterRoleSummary {
	role: SeatRole;
	label: string;
	activeCount: number;
	names: string[];
}

export type RegistryEvent =
	| { type: "change" }
	| { type: "agent-updated"; agent: AgentRecord }
	| { type: "agent-terminal"; agent: AgentRecord }
	| { type: "batch-completed"; batch: BatchRecord; agents: AgentRecord[] };

