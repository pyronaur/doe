import { EventEmitter } from "node:events";
import type { AgentActivity } from "../codex/client.js";

export type AgentLifecycleState = "working" | "completed" | "error" | "awaiting_input";
export type NotificationMode = "wait_all" | "notify_each";
export type ReturnMode = "wait";

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
	startedAt: number;
	completedAt?: number | null;
	parentBatchId?: string | null;
	notificationMode: NotificationMode;
	returnMode: ReturnMode;
	completionNotified?: boolean;
	recovered?: boolean;
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

export interface PersistedRegistrySnapshot {
	version: number;
	savedAt: number;
	agents: AgentRecord[];
	batches: BatchRecord[];
}

export type RegistryEvent =
	| { type: "change" }
	| { type: "agent-updated"; agent: AgentRecord }
	| { type: "agent-terminal"; agent: AgentRecord }
	| { type: "batch-completed"; batch: BatchRecord; agents: AgentRecord[] };

const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "error", "awaiting_input"]);

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

export class SysopRegistry extends EventEmitter {
	private readonly agents = new Map<string, AgentRecord>();
	private readonly batches = new Map<string, BatchRecord>();
	private readonly agentWaiters = new Map<string, Array<(agent: AgentRecord) => void>>();
	private readonly batchWaiters = new Map<string, Array<(agents: AgentRecord[]) => void>>();

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

	upsertAgent(agent: AgentRecord): AgentRecord {
		const previous = this.agents.get(agent.id);
		const next = { ...agent };
		this.agents.set(agent.id, next);
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
		return agent ? { ...agent } : undefined;
	}

	getAgentByThreadId(threadId: string): AgentRecord | undefined {
		for (const agent of this.agents.values()) {
			if (agent.threadId === threadId) return { ...agent };
		}
		return undefined;
	}

	findAgent(identifier: string): AgentRecord | undefined {
		const exact = this.getAgent(identifier) ?? this.getAgentByThreadId(identifier);
		if (exact) return exact;
		const normalized = identifier.trim().toLowerCase();
		for (const agent of this.agents.values()) {
			if (agent.name.trim().toLowerCase() === normalized) return { ...agent };
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
		return agents.map((agent) => ({ ...agent }));
	}

	listBatches(limit?: number): BatchRecord[] {
		let batches = [...this.batches.values()].sort((a, b) => b.startedAt - a.startedAt);
		if (typeof limit === "number") batches = batches.slice(0, limit);
		return batches.map((batch) => ({ ...batch, agentIds: [...batch.agentIds] }));
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

	setAgentSnippet(threadId: string, text: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			latestSnippet: tailSnippet(text),
			latestFinalOutput: text,
		}));
	}

	markCompleted(threadId: string, finalOutput?: string | null) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: "completed",
			activityLabel: "completed",
			completedAt: Date.now(),
			activeTurnId: null,
			latestFinalOutput: finalOutput ?? agent.latestFinalOutput ?? agent.latestSnippet,
			latestSnippet: finalOutput ? tailSnippet(finalOutput) : agent.latestSnippet,
		}));
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
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: "error",
			activityLabel: "error",
			completedAt: Date.now(),
			activeTurnId: null,
			lastError: normalizedError,
			latestSnippet: tailSnippet(normalizedError),
		}));
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
		if (existing && TERMINAL_STATES.has(existing.state)) return Promise.resolve({ ...existing });
		return new Promise<AgentRecord>((resolve, reject) => {
			const waiter = (agent: AgentRecord) => resolve({ ...agent });
			const current = this.agentWaiters.get(agentId) ?? [];
			current.push(waiter);
			this.agentWaiters.set(agentId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentAgent = this.agents.get(agentId);
					if (currentAgent && TERMINAL_STATES.has(currentAgent.state)) {
						resolve({ ...currentAgent });
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
			return Promise.resolve(currentAgents.map((agent) => ({ ...agent })));
		}
		return new Promise<AgentRecord[]>((resolve, reject) => {
			const waiter = (agents: AgentRecord[]) => resolve(agents.map((agent) => ({ ...agent })));
			const current = this.batchWaiters.get(batchId) ?? [];
			current.push(waiter);
			this.batchWaiters.set(batchId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentBatch = this.batches.get(batchId);
					const currentBatchAgents = currentBatch?.agentIds.map((id) => this.agents.get(id)).filter(Boolean) as AgentRecord[];
					if (currentBatchAgents.length > 0 && currentBatchAgents.every((agent) => TERMINAL_STATES.has(agent.state))) {
						resolve(currentBatchAgents.map((agent) => ({ ...agent })));
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
			version: 1,
			savedAt: Date.now(),
			agents: this.listAgents(),
			batches: this.listBatches(),
		};
	}

	restore(snapshot: PersistedRegistrySnapshot | null | undefined) {
		this.agents.clear();
		this.batches.clear();
		if (!snapshot) {
			this.emitChange();
			return;
		}
		for (const agent of snapshot.agents ?? []) {
			this.agents.set(agent.id, {
				...agent,
				returnMode: "wait",
				activityLabel:
					agent.activityLabel ??
					(agent.state === "completed"
						? "completed"
						: agent.state === "error"
							? "error"
							: agent.state === "awaiting_input"
								? "awaiting input"
								: "thinking"),
				recovered: true,
			});
		}
		for (const batch of snapshot.batches ?? []) {
			this.batches.set(batch.id, { ...batch, returnMode: "wait", agentIds: [...batch.agentIds] });
		}
		this.emitChange();
	}

	private updateAgent(agentId: string, updater: (agent: AgentRecord) => AgentRecord) {
		const current = this.agents.get(agentId);
		if (!current) return;
		this.upsertAgent(updater({ ...current }));
	}

	private updateAgentByThread(threadId: string, updater: (agent: AgentRecord) => AgentRecord) {
		for (const agent of this.agents.values()) {
			if (agent.threadId === threadId) {
				this.upsertAgent(updater({ ...agent }));
				return;
			}
		}
	}

	private resolveAgent(agent: AgentRecord) {
		const waiters = this.agentWaiters.get(agent.id) ?? [];
		this.agentWaiters.delete(agent.id);
		for (const waiter of waiters) waiter({ ...agent });
		this.emit("event", { type: "agent-terminal", agent: { ...agent } } satisfies RegistryEvent);
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
		for (const waiter of waiters) waiter(agents.map((agent) => ({ ...agent })));
		this.emit("event", {
			type: "batch-completed",
			batch: { ...nextBatch, agentIds: [...nextBatch.agentIds] },
			agents: agents.map((agent) => ({ ...agent })),
		} satisfies RegistryEvent);
	}

	private emitChange() {
		this.emit("event", { type: "change" } satisfies RegistryEvent);
	}
}
