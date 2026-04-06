import { EventEmitter } from "node:events";
import type { AgentActivity } from "../codex/client.js";
import {
	deriveUsageSnapshot,
	type CurrentContextUsage,
	type AgentCompactionState,
	type AgentUsageSnapshot,
} from "../context-usage.js";

export type AgentLifecycleState = "working" | "completed" | "error" | "awaiting_input" | "finalized";
export type NotificationMode = "wait_all" | "notify_each";
export type ReturnMode = "wait";
export type RosterBucket = "senior" | "mid" | "research" | "contractor";
export type AssignableRosterBucket = Exclude<RosterBucket, "contractor">;
export type SeatKind = "named" | "contractor";

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
	parentBatchId?: string | null;
	notificationMode: NotificationMode;
	returnMode: ReturnMode;
	completionNotified?: boolean;
	recovered?: boolean;
	seatName?: string | null;
	seatBucket?: RosterBucket | null;
	seatKind?: SeatKind | null;
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
	bucket: RosterBucket;
	kind: SeatKind;
	order: number;
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

export interface RosterBucketSummary {
	bucket: RosterBucket;
	label: string;
	activeCount: number;
	names: string[];
}

export type RegistryEvent =
	| { type: "change" }
	| { type: "agent-updated"; agent: AgentRecord }
	| { type: "agent-terminal"; agent: AgentRecord }
	| { type: "batch-completed"; batch: BatchRecord; agents: AgentRecord[] };

export const ROSTER_BUCKET_ORDER = ["senior", "mid", "research", "contractor"] as const;
export const ROSTER_BUCKET_LABELS: Record<RosterBucket, string> = {
	senior: "Senior Engineers",
	mid: "Mid-level Engineers",
	research: "Researchers/Assistants",
	contractor: "Contractors",
};

const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "error", "awaiting_input", "finalized"]);
const ATTACHED_STATES = new Set<AgentLifecycleState>(["working", "awaiting_input", "completed"]);
const RECOVERABLE_STATES = new Set<AgentLifecycleState>(["working", "awaiting_input"]);
const CONTRACTOR_NAME = /^contractor-(\d+)$/i;
const FIXED_SEATS: Array<{ name: string; bucket: AssignableRosterBucket; order: number }> = [
	{ name: "Tony", bucket: "senior", order: 1 },
	{ name: "Bruce", bucket: "senior", order: 2 },
	{ name: "Strange", bucket: "senior", order: 3 },
	{ name: "Peter", bucket: "mid", order: 1 },
	{ name: "Sam", bucket: "mid", order: 2 },
	{ name: "Hope", bucket: "research", order: 1 },
	{ name: "Scott", bucket: "research", order: 2 },
	{ name: "Jane", bucket: "research", order: 3 },
	{ name: "Pepper", bucket: "research", order: 4 },
];

function normalizeErrorText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return text;
	try {
		const parsed = JSON.parse(trimmed);
		const message = parsed?.error?.message;
		if (typeof message === "string" && message.trim()) {
			return message.trim();
		}
	} catch {}
	return text;
}

function normalizeSeatName(name: string): string {
	return name.trim().toLowerCase();
}

function contractorNumber(name: string): number | null {
	const match = name.match(CONTRACTOR_NAME);
	if (!match) return null;
	const parsed = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function defaultSeatRecord(input: { name: string; bucket: RosterBucket; kind: SeatKind; order: number }): RosterSeatRecord {
	return {
		name: input.name,
		bucket: input.bucket,
		kind: input.kind,
		order: input.order,
		activeAgentId: null,
		lastFinishedAgentId: null,
		lastThreadId: null,
		lastFinishNote: null,
		lastReuseSummary: null,
	};
}

function cloneSeat(seat: RosterSeatRecord): RosterSeatRecord {
	return {
		...seat,
		activeAgentId: seat.activeAgentId ?? null,
		lastFinishedAgentId: seat.lastFinishedAgentId ?? null,
		lastThreadId: seat.lastThreadId ?? null,
		lastFinishNote: seat.lastFinishNote ?? null,
		lastReuseSummary: seat.lastReuseSummary ?? null,
	};
}

function seatSort(a: RosterSeatRecord, b: RosterSeatRecord): number {
	const bucketDiff = ROSTER_BUCKET_ORDER.indexOf(a.bucket) - ROSTER_BUCKET_ORDER.indexOf(b.bucket);
	if (bucketDiff !== 0) return bucketDiff;
	if (a.order !== b.order) return a.order - b.order;
	return a.name.localeCompare(b.name);
}

function tailSnippet(text: string, maxChars = 1800, maxLines = 12): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
	let lines = normalized.split("\n").map((line) => line.replace(/\s+$/g, ""));
	while (lines.length > 0 && lines[0] === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) return "";
	let clippedByLines = false;
	if (lines.length > maxLines) {
		lines = lines.slice(lines.length - maxLines);
		clippedByLines = true;
	}
	let output = lines.join("\n");
	let clippedByChars = false;
	if (output.length > maxChars) {
		output = output.slice(output.length - maxChars);
		clippedByChars = true;
	}
	output = output.trim();
	if (clippedByLines || clippedByChars) {
		output = `…${output}`;
	}
	return output;
}

function cloneMessage(message: AgentMessageRecord): AgentMessageRecord {
	return { ...message, completedAt: message.completedAt ?? null };
}

function cloneAgent(agent: AgentRecord): AgentRecord {
	return {
		...agent,
		messages: (agent.messages ?? []).map(cloneMessage),
		usage: agent.usage ? {
			...agent.usage,
			total: { ...agent.usage.total },
			last: { ...agent.usage.last },
		} : null,
		compaction: agent.compaction ? { ...agent.compaction } : null,
		historyHydratedAt: agent.historyHydratedAt ?? null,
		seatName: agent.seatName ?? null,
		seatBucket: agent.seatBucket ?? null,
		seatKind: agent.seatKind ?? null,
		runStartedAt: agent.runStartedAt ?? agent.startedAt,
		finishNote: agent.finishNote ?? null,
		reuseSummary: agent.reuseSummary ?? null,
	};
}

function createCompactionState(previous?: AgentCompactionState | null): AgentCompactionState {
	return {
		inProgress: previous?.inProgress ?? false,
		count: previous?.count ?? 0,
		lastStartedAt: previous?.lastStartedAt ?? null,
		lastCompletedAt: previous?.lastCompletedAt ?? null,
		lastTurnId: previous?.lastTurnId ?? null,
		lastItemId: previous?.lastItemId ?? null,
		lastSignal: previous?.lastSignal ?? null,
	};
}

function sameLogicalMessage(a: AgentMessageRecord, b: AgentMessageRecord): boolean {
	if (a.itemId && b.itemId) return a.itemId === b.itemId;
	if (a.role !== b.role || a.turnId !== b.turnId) return false;
	if (a.role === "user") return true;
	if (!a.text || !b.text) return false;
	return a.text === b.text || a.text.startsWith(b.text) || b.text.startsWith(a.text);
}

function latestAgentSummary(messages: AgentMessageRecord[]): { latestSnippet: string; latestFinalOutput: string | null } | null {
	const lastAgentMessage = [...messages].reverse().find((message) => message.role === "agent" && message.text.trim().length > 0);
	if (!lastAgentMessage) return null;
	return {
		latestSnippet: tailSnippet(lastAgentMessage.text),
		latestFinalOutput: lastAgentMessage.streaming ? null : lastAgentMessage.text,
	};
}

function isAttachedState(state: AgentLifecycleState): boolean {
	return ATTACHED_STATES.has(state);
}

function isRecoverableState(state: AgentLifecycleState): boolean {
	return RECOVERABLE_STATES.has(state);
}

function normalizeAgentRecord(agent: AgentRecord): AgentRecord {
	return {
		...cloneAgent(agent),
		returnMode: "wait",
		activityLabel:
			agent.activityLabel ??
			(agent.state === "completed"
				? "completed"
				: agent.state === "error"
					? "error"
					: agent.state === "awaiting_input"
						? "awaiting input"
						: agent.state === "finalized"
							? "completed"
							: "thinking"),
		recovered: true,
		compaction: agent.compaction ? createCompactionState(agent.compaction) : null,
		runStartedAt: agent.runStartedAt ?? agent.startedAt,
	};
}

export function mergeHydratedMessages(current: AgentMessageRecord[], hydrated: AgentMessageRecord[]): AgentMessageRecord[] {
	const live = current.map(cloneMessage);
	const history = hydrated.map(cloneMessage);
	if (live.length === 0) return history;
	if (history.length === 0) return live;

	let bestOffset = -1;
	let bestOverlap = 0;
	for (let offset = 0; offset < history.length; offset += 1) {
		let overlap = 0;
		while (
			offset + overlap < history.length &&
			overlap < live.length &&
			sameLogicalMessage(history[offset + overlap]!, live[overlap]!)
		) {
			overlap += 1;
		}
		if (overlap === 0) continue;
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			bestOffset = offset;
		}
	}

	if (bestOverlap > 0) {
		return [...history.slice(0, bestOffset), ...live];
	}

	const mergedHistory = history.filter((message) => !live.some((entry) => sameLogicalMessage(entry, message)));
	return [...mergedHistory, ...live];
}

export class DoeRegistry extends EventEmitter {
	private readonly agents = new Map<string, AgentRecord>();
	private readonly batches = new Map<string, BatchRecord>();
	private readonly seats = new Map<string, RosterSeatRecord>();
	private readonly agentWaiters = new Map<string, Array<(agent: AgentRecord) => void>>();
	private readonly batchWaiters = new Map<string, Array<(agents: AgentRecord[]) => void>>();
	private nextContractorNumber = 1;

	constructor() {
		super();
		this.resetRoster();
	}

	createBatch(input: {
		id: string;
		name: string;
		agentIds: string[];
		notificationMode: NotificationMode;
		returnMode: ReturnMode;
	}): BatchRecord {
		const batch: BatchRecord = {
			id: input.id,
			name: input.name,
			agentIds: [...input.agentIds],
			notificationMode: input.notificationMode,
			returnMode: input.returnMode,
			startedAt: Date.now(),
			completedAt: null,
			notified: false,
		};
		this.batches.set(batch.id, batch);
		this.emitChange();
		return batch;
	}

	assignSeat(input: { agentId: string; ic?: string | null; bucket?: AssignableRosterBucket | null }): RosterSeatRecord {
		const seat = input.ic?.trim()
			? this.requireSeatForAssignment(input.ic)
			: this.allocateSeat(input.bucket ?? "mid");
		if (seat.activeAgentId && seat.activeAgentId !== input.agentId) {
			throw new Error(`${seat.name} already has an active assignment.`);
		}
		const next = { ...seat, activeAgentId: input.agentId };
		this.seats.set(normalizeSeatName(next.name), next);
		this.emitChange();
		return cloneSeat(next);
	}

	upsertAgent(agent: AgentRecord): AgentRecord {
		const previous = this.agents.get(agent.id);
		const next = cloneAgent(agent);
		this.agents.set(agent.id, next);
		this.syncSeatLinks(previous, next);
		const current = this.getAgent(agent.id)!;
		this.emit("event", { type: "agent-updated", agent: current } satisfies RegistryEvent);
		if (current.state !== previous?.state && TERMINAL_STATES.has(current.state)) {
			this.resolveAgent(current);
		}
		this.checkBatchCompletion(current.parentBatchId ?? undefined);
		this.emitChange();
		return current;
	}

	getAgent(id: string): AgentRecord | undefined {
		const agent = this.agents.get(id);
		return agent ? cloneAgent(agent) : undefined;
	}

	getAgentByThreadId(threadId: string): AgentRecord | undefined {
		for (const agent of this.agents.values()) {
			if (agent.threadId === threadId) return cloneAgent(agent);
		}
		return undefined;
	}

	findSeat(name: string): RosterSeatRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		return seat ? cloneSeat(seat) : undefined;
	}

	findActiveSeatAgent(name: string): AgentRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat?.activeAgentId) return undefined;
		return this.getAgent(seat.activeAgentId);
	}

	findLastFinishedSeatAgent(name: string): AgentRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat?.lastFinishedAgentId) return undefined;
		return this.getAgent(seat.lastFinishedAgentId);
	}

	findAgent(identifier: string): AgentRecord | undefined {
		const seatMatch = this.findActiveSeatAgent(identifier) ?? this.findLastFinishedSeatAgent(identifier);
		if (seatMatch) return seatMatch;
		const exact = this.getAgent(identifier) ?? this.getAgentByThreadId(identifier);
		if (exact) return exact;
		const normalized = identifier.trim().toLowerCase();
		for (const agent of this.agents.values()) {
			if (agent.name.trim().toLowerCase() === normalized) return cloneAgent(agent);
		}
		return undefined;
	}

	getBatch(id: string): BatchRecord | undefined {
		const batch = this.batches.get(id);
		return batch ? { ...batch, agentIds: [...batch.agentIds] } : undefined;
	}

	listAgents(options: { includeCompleted?: boolean; limit?: number; state?: AgentLifecycleState } = {}): AgentRecord[] {
		const { includeCompleted = true, limit, state } = options;
		let agents = [...this.agents.values()];
		agents = agents.filter((agent) => {
			if (state && agent.state !== state) return false;
			if (!includeCompleted && TERMINAL_STATES.has(agent.state)) return false;
			return true;
		});
		agents.sort((a, b) => b.startedAt - a.startedAt);
		if (typeof limit === "number") agents = agents.slice(0, limit);
		return agents.map(cloneAgent);
	}

	listRecoverableAgents(): AgentRecord[] {
		return this.listAgents({ includeCompleted: true }).filter((agent) => agent.threadId && isRecoverableState(agent.state));
	}

	listBatches(limit?: number): BatchRecord[] {
		let batches = [...this.batches.values()].sort((a, b) => b.startedAt - a.startedAt);
		if (typeof limit === "number") batches = batches.slice(0, limit);
		return batches.map((batch) => ({ ...batch, agentIds: [...batch.agentIds] }));
	}

	listRosterSeats(): RosterSeatRecord[] {
		return [...this.seats.values()].sort(seatSort).map(cloneSeat);
	}

	listRosterAssignments(options: { includeAwaitingInput?: boolean; includeHistory?: boolean; limit?: number } = {}): RosterAssignmentRecord[] {
		const { includeAwaitingInput = true, includeHistory = false, limit } = options;
		const entries: RosterAssignmentRecord[] = [];
		for (const seat of this.listRosterSeats()) {
			const active = seat.activeAgentId ? this.getAgent(seat.activeAgentId) : undefined;
			if (active?.state === "working") {
				entries.push({ seat, agent: active, source: "active" });
				continue;
			}
			if (includeAwaitingInput && active?.state === "awaiting_input") {
				entries.push({ seat, agent: active, source: "active" });
				continue;
			}
			if (active?.state === "completed") {
				entries.push({ seat, agent: active, source: "active" });
				continue;
			}
			if (includeHistory && seat.lastFinishedAgentId) {
				const history = this.getAgent(seat.lastFinishedAgentId);
				if (history) entries.push({ seat, agent: history, source: "history" });
			}
		}
		return typeof limit === "number" ? entries.slice(0, limit) : entries;
	}

	getRosterBucketSummaries(options: { includeAwaitingInput?: boolean; includeHistory?: boolean } = {}): RosterBucketSummary[] {
		const counts = new Map<RosterBucket, RosterBucketSummary>();
		for (const bucket of ROSTER_BUCKET_ORDER) {
			counts.set(bucket, { bucket, label: ROSTER_BUCKET_LABELS[bucket], activeCount: 0, names: [] });
		}
		for (const entry of this.listRosterAssignments({
			includeAwaitingInput: options.includeAwaitingInput ?? true,
			includeHistory: options.includeHistory ?? false,
		})) {
			const summary = counts.get(entry.seat.bucket)!;
			summary.activeCount += 1;
			summary.names.push(entry.seat.name);
		}
		return [...ROSTER_BUCKET_ORDER].map((bucket) => counts.get(bucket)!);
	}

	finalizeSeat(
		ic: string,
		input: { note?: string | null; reuseSummary?: string | null } = {},
	): { seat: RosterSeatRecord; agent: AgentRecord } {
		const seat = this.requireSeat(ic);
		if (!seat.activeAgentId) {
			throw new Error(`${seat.name} has no occupied assignment to finalize.`);
		}
		const agent = this.agents.get(seat.activeAgentId);
		if (!agent) {
			throw new Error(`${seat.name} is missing its active assignment record.`);
		}
		if (agent.state === "working") {
			throw new Error(`${seat.name} is still working. Wait, resume, or cancel before finalizing.`);
		}

		const finalized = {
			...cloneAgent(agent),
			state: "finalized" as const,
			activityLabel: "completed" as const,
			activeTurnId: null,
			completedAt: agent.completedAt ?? Date.now(),
			finishNote: input.note ?? agent.finishNote ?? null,
			reuseSummary: input.reuseSummary ?? agent.reuseSummary ?? null,
			latestSnippet: input.note ? tailSnippet(input.note) : agent.latestSnippet,
		};
		this.releaseSeat(finalized, {
			note: finalized.finishNote ?? null,
			reuseSummary: finalized.reuseSummary ?? null,
		});
		const saved = this.upsertAgent(finalized);
		return { seat: this.findSeat(seat.name)!, agent: saved };
	}

	markThreadAttached(agentId: string, details: { threadId: string; activeTurnId?: string | null; recovered?: boolean }) {
		this.updateAgent(agentId, (agent) => ({
			...agent,
			threadId: details.threadId,
			activeTurnId: details.activeTurnId ?? agent.activeTurnId ?? null,
			recovered: details.recovered ?? false,
		}));
	}

	markThreadStatus(threadId: string, status: { type?: string; activeFlags?: string[] } | null | undefined) {
		if (!status) return;
		this.updateAgentByThread(threadId, (agent) => {
			let state = agent.state;
			let activityLabel = agent.activityLabel ?? null;
			if (status.type === "active") {
				const waiting = (status.activeFlags ?? []).includes("waitingOnApproval");
				state = waiting ? "awaiting_input" : "working";
				activityLabel = waiting ? "awaiting approval" : activityLabel;
			} else if (status.type === "systemError") {
				state = "error";
				activityLabel = "error";
			}
			return { ...agent, state, activityLabel };
		});
	}

	markTurnStarted(threadId: string, turnId: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			activeTurnId: turnId,
			state: "working",
			activityLabel: "thinking",
			runStartedAt: agent.runStartedAt ?? agent.startedAt,
			completedAt: null,
		}));
	}

	markActivity(threadId: string, activityLabel: AgentActivity) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: activityLabel === "awaiting input" || activityLabel === "awaiting approval" ? "awaiting_input" : agent.state,
			activityLabel,
		}));
	}

	appendAgentDelta(threadId: string, delta: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			latestSnippet: tailSnippet(`${agent.latestSnippet}${delta}`),
		}));
	}

	markTokenUsage(threadId: string, turnId: string | null, usage: CurrentContextUsage) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			usage: deriveUsageSnapshot(usage, turnId),
		}));
	}

	markCompactionStarted(threadId: string, details: { turnId?: string | null; itemId?: string | null }) {
		this.updateAgentByThread(threadId, (agent) => {
			const compaction = createCompactionState(agent.compaction);
			return {
				...agent,
				compaction: {
					...compaction,
					inProgress: true,
					lastStartedAt: Date.now(),
					lastTurnId: details.turnId ?? compaction.lastTurnId ?? null,
					lastItemId: details.itemId ?? null,
					lastSignal: "contextCompaction",
				},
			};
		});
	}

	markCompactionCompleted(
		threadId: string,
		details: { turnId?: string | null; itemId?: string | null; source: "contextCompaction" | "thread/compacted" },
	) {
		this.updateAgentByThread(threadId, (agent) => {
			const compaction = createCompactionState(agent.compaction);
			const sameTurn = compaction.lastCompletedAt !== null && compaction.lastTurnId === (details.turnId ?? null);
			return {
				...agent,
				compaction: {
					...compaction,
					inProgress: false,
					count: sameTurn ? compaction.count : compaction.count + 1,
					lastCompletedAt: Date.now(),
					lastTurnId: details.turnId ?? compaction.lastTurnId ?? null,
					lastItemId: details.itemId ?? compaction.lastItemId ?? null,
					lastSignal: details.source,
				},
			};
		});
	}

	appendUserMessage(agentId: string, turnId: string, text: string) {
		this.updateAgent(agentId, (agent) => {
			const nextMessages = [
				...agent.messages,
				{
					turnId,
					itemId: null,
					role: "user",
					text,
					streaming: false,
					createdAt: Date.now(),
					completedAt: Date.now(),
				} satisfies AgentMessageRecord,
			];
			return {
				...agent,
				messages: nextMessages,
			};
		});
	}

	appendAgentMessageDelta(threadId: string, turnId: string, itemId: string, delta: string) {
		this.updateAgentByThread(threadId, (agent) => {
			const nextMessages = [...agent.messages];
			const index = nextMessages.findIndex((message) => message.itemId === itemId);
			if (index >= 0) {
				const current = nextMessages[index]!;
				nextMessages[index] = {
					...current,
					turnId,
					text: `${current.text}${delta}`,
					streaming: true,
					completedAt: null,
				};
			} else {
				nextMessages.push({
					turnId,
					itemId,
					role: "agent",
					text: delta,
					streaming: true,
					createdAt: Date.now(),
					completedAt: null,
				});
			}
			const summary = latestAgentSummary(nextMessages);
			return {
				...agent,
				messages: nextMessages,
				latestSnippet: summary?.latestSnippet ?? agent.latestSnippet,
				latestFinalOutput: summary?.latestFinalOutput ?? null,
			};
		});
	}

	completeAgentMessage(threadId: string, turnId: string, itemId: string, text: string) {
		this.updateAgentByThread(threadId, (agent) => {
			const nextMessages = [...agent.messages];
			const index = nextMessages.findIndex((message) => message.itemId === itemId);
			const completedAt = Date.now();
			if (index >= 0) {
				nextMessages[index] = {
					...nextMessages[index]!,
					turnId,
					text,
					streaming: false,
					completedAt,
				};
			} else {
				nextMessages.push({
					turnId,
					itemId,
					role: "agent",
					text,
					streaming: false,
					createdAt: completedAt,
					completedAt,
				});
			}
			const summary = latestAgentSummary(nextMessages);
			return {
				...agent,
				messages: nextMessages,
				latestSnippet: summary?.latestSnippet ?? agent.latestSnippet,
				latestFinalOutput: summary?.latestFinalOutput ?? agent.latestFinalOutput ?? null,
			};
		});
	}

	hydrateAgentMessages(agentId: string, messages: AgentMessageRecord[]) {
		this.updateAgent(agentId, (agent) => {
			const nextMessages = mergeHydratedMessages(agent.messages, messages);
			const summary = latestAgentSummary(nextMessages);
			return {
				...agent,
				messages: nextMessages,
				historyHydratedAt: Date.now(),
				latestSnippet: summary?.latestSnippet ?? agent.latestSnippet,
				latestFinalOutput: summary?.latestFinalOutput ?? agent.latestFinalOutput ?? null,
			};
		});
	}

	getAgentMessages(agentId: string): AgentMessageRecord[] {
		return (this.agents.get(agentId)?.messages ?? []).map(cloneMessage);
	}

	setAgentSnippet(threadId: string, text: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			latestSnippet: tailSnippet(text),
			latestFinalOutput: text,
		}));
	}

	markCompleted(threadId: string, finalOutput?: string | null) {
		this.updateAgentByThread(threadId, (agent) => {
			const summary = latestAgentSummary(agent.messages);
			const output = finalOutput ?? summary?.latestFinalOutput ?? agent.latestFinalOutput ?? agent.latestSnippet;
			const next = {
				...agent,
				state: "completed" as const,
				activityLabel: "completed" as const,
				completedAt: Date.now(),
				activeTurnId: null,
				latestFinalOutput: output,
				latestSnippet: output ? tailSnippet(output) : agent.latestSnippet,
			};
			return next;
		});
	}

	markAwaitingInput(threadId: string, note?: string | null) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: "awaiting_input",
			activityLabel: "awaiting input",
			completedAt: Date.now(),
			activeTurnId: null,
			latestSnippet: note ? tailSnippet(note) : agent.latestSnippet,
		}));
	}

	markError(threadId: string, error: string) {
		const normalizedError = normalizeErrorText(error);
		this.updateAgentByThread(threadId, (agent) => {
			const next = {
				...agent,
				state: "error" as const,
				activityLabel: "error" as const,
				completedAt: Date.now(),
				activeTurnId: null,
				lastError: normalizedError,
				latestSnippet: tailSnippet(normalizedError),
			};
			return next;
		});
	}

	markAgentError(agentId: string, error: string) {
		const normalizedError = normalizeErrorText(error);
		this.updateAgent(agentId, (agent) => {
			const next = {
				...agent,
				state: "error" as const,
				activityLabel: "error" as const,
				completedAt: Date.now(),
				activeTurnId: null,
				lastError: normalizedError,
				latestSnippet: tailSnippet(normalizedError),
			};
			return next;
		});
	}

	markCompletionNotified(agentId: string) {
		this.updateAgent(agentId, (agent) => ({ ...agent, completionNotified: true }));
	}

	markBatchNotified(batchId: string) {
		const batch = this.batches.get(batchId);
		if (!batch) return;
		this.batches.set(batch.id, { ...batch, notified: true });
		this.emitChange();
	}

	waitForAgent(agentId: string, signal?: AbortSignal): Promise<AgentRecord> {
		const existing = this.agents.get(agentId);
		if (existing && TERMINAL_STATES.has(existing.state)) return Promise.resolve(cloneAgent(existing));
		return new Promise<AgentRecord>((resolve, reject) => {
			const waiter = (agent: AgentRecord) => resolve(cloneAgent(agent));
			const current = this.agentWaiters.get(agentId) ?? [];
			current.push(waiter);
			this.agentWaiters.set(agentId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentAgent = this.agents.get(agentId);
					if (currentAgent && TERMINAL_STATES.has(currentAgent.state)) {
						resolve(cloneAgent(currentAgent));
						return;
					}
					this.agentWaiters.set(
						agentId,
						(this.agentWaiters.get(agentId) ?? []).filter((entry) => entry !== waiter),
					);
					reject(new Error("Cancelled"));
				},
				{ once: true },
			);
		});
	}

	waitForBatch(batchId: string, signal?: AbortSignal): Promise<AgentRecord[]> {
		const batch = this.batches.get(batchId);
		if (!batch) return Promise.resolve([]);
		const currentAgents = batch.agentIds.map((id) => this.agents.get(id)).filter(Boolean) as AgentRecord[];
		if (currentAgents.length > 0 && currentAgents.every((agent) => TERMINAL_STATES.has(agent.state))) {
			return Promise.resolve(currentAgents.map(cloneAgent));
		}
		return new Promise<AgentRecord[]>((resolve, reject) => {
			const waiter = (agents: AgentRecord[]) => resolve(agents.map(cloneAgent));
			const current = this.batchWaiters.get(batchId) ?? [];
			current.push(waiter);
			this.batchWaiters.set(batchId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentBatch = this.batches.get(batchId);
					const currentBatchAgents = currentBatch?.agentIds.map((id) => this.agents.get(id)).filter(Boolean) as AgentRecord[];
					if (currentBatchAgents.length > 0 && currentBatchAgents.every((agent) => TERMINAL_STATES.has(agent.state))) {
						resolve(currentBatchAgents.map(cloneAgent));
						return;
					}
					this.batchWaiters.set(
						batchId,
						(this.batchWaiters.get(batchId) ?? []).filter((entry) => entry !== waiter),
					);
					reject(new Error("Cancelled"));
				},
				{ once: true },
			);
		});
	}

	serialize(): PersistedRegistrySnapshot {
		return {
			version: 5,
			savedAt: Date.now(),
			agents: this.listAgents(),
			batches: this.listBatches(),
			roster: {
				seats: this.listRosterSeats(),
				nextContractorNumber: this.nextContractorNumber,
			},
		};
	}

	restore(snapshot: PersistedRegistrySnapshot | null | undefined) {
		this.agents.clear();
		this.batches.clear();
		this.resetRoster();
		if (!snapshot) {
			this.emitChange();
			return;
		}
		for (const agent of snapshot.agents ?? []) {
			this.agents.set(agent.id, normalizeAgentRecord(agent));
		}
		for (const batch of snapshot.batches ?? []) {
			this.batches.set(batch.id, { ...batch, returnMode: "wait", agentIds: [...batch.agentIds] });
		}
		if (snapshot.roster?.seats?.length) {
			this.restoreRoster(snapshot.roster);
		} else {
			this.migrateLegacyRosterLinks();
		}
		this.normalizeRosterState();
		this.emitChange();
	}

	private resetRoster() {
		this.seats.clear();
		for (const seat of FIXED_SEATS) {
			this.seats.set(
				normalizeSeatName(seat.name),
				defaultSeatRecord({
					name: seat.name,
					bucket: seat.bucket,
					kind: "named",
					order: seat.order,
				}),
			);
		}
		this.nextContractorNumber = 1;
	}

	private restoreRoster(roster: PersistedRosterSnapshot) {
		this.resetRoster();
		for (const seat of roster.seats ?? []) {
			const normalizedName = normalizeSeatName(seat.name);
			const fixed = FIXED_SEATS.find((entry) => normalizeSeatName(entry.name) === normalizedName);
			if (fixed) {
				this.seats.set(normalizedName, {
					...defaultSeatRecord({ name: fixed.name, bucket: fixed.bucket, kind: "named", order: fixed.order }),
					activeAgentId: seat.activeAgentId ?? null,
					lastFinishedAgentId: seat.lastFinishedAgentId ?? null,
					lastThreadId: seat.lastThreadId ?? null,
					lastFinishNote: seat.lastFinishNote ?? null,
					lastReuseSummary: seat.lastReuseSummary ?? null,
				});
				continue;
			}
			const number = contractorNumber(seat.name);
			if (number === null) continue;
			this.seats.set(
				normalizedName,
				{
					...defaultSeatRecord({
						name: `contractor-${number}`,
						bucket: "contractor",
						kind: "contractor",
						order: number,
					}),
					activeAgentId: seat.activeAgentId ?? null,
					lastFinishedAgentId: seat.lastFinishedAgentId ?? null,
					lastThreadId: seat.lastThreadId ?? null,
					lastFinishNote: seat.lastFinishNote ?? null,
					lastReuseSummary: seat.lastReuseSummary ?? null,
				},
			);
		}
		const highestSeen = Math.max(
			0,
			...this.listRosterSeats().map((seat) => contractorNumber(seat.name) ?? 0),
		);
		this.nextContractorNumber = Math.max(roster.nextContractorNumber ?? 1, highestSeen + 1);
	}

	private migrateLegacyRosterLinks() {
		for (const seat of FIXED_SEATS) {
			const agent = [...this.agents.values()].find(
				(entry) =>
					entry.name === seat.name &&
					!entry.seatName &&
					isAttachedState(entry.state) &&
					!(this.seats.get(normalizeSeatName(seat.name))?.activeAgentId),
			);
			if (!agent) continue;
			const nextSeat = {
				...this.seats.get(normalizeSeatName(seat.name))!,
				activeAgentId: agent.id,
			};
			this.seats.set(normalizeSeatName(seat.name), nextSeat);
			this.agents.set(agent.id, {
				...cloneAgent(agent),
				name: seat.name,
				seatName: seat.name,
				seatBucket: seat.bucket,
				seatKind: "named",
			});
		}
	}

	private normalizeRosterState() {
		for (const agent of this.agents.values()) {
			if (!agent.seatName) continue;
			const key = normalizeSeatName(agent.seatName);
			const existing = this.seats.get(key);
			if (!existing) {
				const number = contractorNumber(agent.seatName);
				if (number === null) continue;
				this.seats.set(
					key,
					defaultSeatRecord({
						name: `contractor-${number}`,
						bucket: "contractor",
						kind: "contractor",
						order: number,
					}),
				);
			}
		}

		for (const seat of this.seats.values()) {
			const active = seat.activeAgentId ? this.agents.get(seat.activeAgentId) : undefined;
			if (active && !isAttachedState(active.state)) {
				seat.activeAgentId = null;
				seat.lastFinishedAgentId = active.id;
				seat.lastThreadId = active.threadId ?? seat.lastThreadId ?? null;
				seat.lastFinishNote = active.finishNote ?? seat.lastFinishNote ?? null;
				seat.lastReuseSummary = active.reuseSummary ?? seat.lastReuseSummary ?? null;
			}
			if (seat.activeAgentId && !this.agents.has(seat.activeAgentId)) {
				seat.activeAgentId = null;
			}
			if (seat.lastFinishedAgentId && !this.agents.has(seat.lastFinishedAgentId)) {
				seat.lastFinishedAgentId = null;
			}
		}

		for (const [id, agent] of this.agents.entries()) {
			if (!agent.seatName) continue;
			const seat = this.seats.get(normalizeSeatName(agent.seatName));
			if (!seat) continue;
			const next = {
				...cloneAgent(agent),
				name: seat.name,
				seatBucket: seat.bucket,
				seatKind: seat.kind,
			};
			if (isAttachedState(next.state)) {
				if (!seat.activeAgentId) {
					seat.activeAgentId = next.id;
				}
			} else if (!seat.activeAgentId && !seat.lastFinishedAgentId) {
				seat.lastFinishedAgentId = next.id;
				seat.lastThreadId = next.threadId ?? seat.lastThreadId ?? null;
			}
			this.agents.set(id, next);
		}

		const highestSeen = Math.max(
			0,
			...this.listRosterSeats().map((seat) => contractorNumber(seat.name) ?? 0),
		);
		this.nextContractorNumber = Math.max(this.nextContractorNumber, highestSeen + 1);
	}

	private requireSeat(name: string): RosterSeatRecord {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat) throw new Error(`Unknown IC seat "${name}".`);
		return cloneSeat(seat);
	}

	private requireSeatForAssignment(name: string): RosterSeatRecord {
		const seat = this.requireSeat(name);
		if (seat.activeAgentId) {
			throw new Error(`${seat.name} already has an active assignment.`);
		}
		return seat;
	}

	private allocateSeat(bucket: AssignableRosterBucket): RosterSeatRecord {
		const named = this.listRosterSeats().find((seat) => seat.kind === "named" && seat.bucket === bucket && !seat.activeAgentId);
		if (named) return named;
		const contractor = this.listRosterSeats().find((seat) => seat.kind === "contractor" && !seat.activeAgentId);
		if (contractor) return contractor;
		const seat = defaultSeatRecord({
			name: `contractor-${this.nextContractorNumber}`,
			bucket: "contractor",
			kind: "contractor",
			order: this.nextContractorNumber,
		});
		this.nextContractorNumber += 1;
		this.seats.set(normalizeSeatName(seat.name), seat);
		return cloneSeat(seat);
	}

	private releaseSeat(agent: AgentRecord, input: { note?: string | null; reuseSummary?: string | null } = {}) {
		if (!agent.seatName) return;
		const key = normalizeSeatName(agent.seatName);
		const seat = this.seats.get(key);
		if (!seat) return;
		const nextSeat: RosterSeatRecord = {
			...seat,
			activeAgentId: seat.activeAgentId === agent.id ? null : seat.activeAgentId ?? null,
			lastFinishedAgentId: agent.id,
			lastThreadId: agent.threadId ?? seat.lastThreadId ?? null,
			lastFinishNote: input.note ?? agent.finishNote ?? seat.lastFinishNote ?? null,
			lastReuseSummary: input.reuseSummary ?? agent.reuseSummary ?? seat.lastReuseSummary ?? null,
		};
		this.seats.set(key, nextSeat);
	}

	private syncSeatLinks(previous: AgentRecord | undefined, next: AgentRecord) {
		if (previous?.seatName && previous.seatName !== next.seatName) {
			const previousSeat = this.seats.get(normalizeSeatName(previous.seatName));
			if (previousSeat?.activeAgentId === previous.id) {
				this.seats.set(normalizeSeatName(previous.seatName), { ...previousSeat, activeAgentId: null });
			}
		}
		if (!next.seatName) return;
		const key = normalizeSeatName(next.seatName);
		const seat = this.seats.get(key);
		if (!seat) return;
		const nextSeat = { ...seat };
		next.name = seat.name;
		next.seatBucket = seat.bucket;
		next.seatKind = seat.kind;
		if (isAttachedState(next.state)) {
			nextSeat.activeAgentId = next.id;
		} else {
			if (nextSeat.activeAgentId === next.id) nextSeat.activeAgentId = null;
			nextSeat.lastFinishedAgentId = next.id;
			nextSeat.lastThreadId = next.threadId ?? nextSeat.lastThreadId ?? null;
			nextSeat.lastFinishNote = next.finishNote ?? nextSeat.lastFinishNote ?? null;
			nextSeat.lastReuseSummary = next.reuseSummary ?? nextSeat.lastReuseSummary ?? null;
		}
		this.seats.set(key, nextSeat);
	}

	private updateAgent(agentId: string, updater: (agent: AgentRecord) => AgentRecord) {
		const current = this.agents.get(agentId);
		if (!current) return;
		this.upsertAgent(updater(cloneAgent(current)));
	}

	private updateAgentByThread(threadId: string, updater: (agent: AgentRecord) => AgentRecord) {
		for (const agent of this.agents.values()) {
			if (agent.threadId === threadId) {
				this.upsertAgent(updater(cloneAgent(agent)));
				return;
			}
		}
	}

	private resolveAgent(agent: AgentRecord) {
		const waiters = this.agentWaiters.get(agent.id) ?? [];
		this.agentWaiters.delete(agent.id);
		for (const waiter of waiters) waiter(cloneAgent(agent));
		this.emit("event", { type: "agent-terminal", agent: cloneAgent(agent) } satisfies RegistryEvent);
	}

	private checkBatchCompletion(batchId?: string) {
		if (!batchId) return;
		const batch = this.batches.get(batchId);
		if (!batch) return;
		if (batch.completedAt) return;
		const agents = batch.agentIds.map((id) => this.agents.get(id)).filter(Boolean) as AgentRecord[];
		if (agents.length === 0) return;
		if (!agents.every((agent) => TERMINAL_STATES.has(agent.state))) return;
		const nextBatch = { ...batch, completedAt: Date.now() };
		this.batches.set(batch.id, nextBatch);
		const waiters = this.batchWaiters.get(batch.id) ?? [];
		this.batchWaiters.delete(batch.id);
		for (const waiter of waiters) waiter(agents.map(cloneAgent));
		this.emit("event", {
			type: "batch-completed",
			batch: { ...nextBatch, agentIds: [...nextBatch.agentIds] },
			agents: agents.map(cloneAgent),
		} satisfies RegistryEvent);
	}

	private emitChange() {
		this.emit("event", { type: "change" } satisfies RegistryEvent);
	}
}
