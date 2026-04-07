import { EventEmitter } from "node:events";
import { IC_CONFIG, IC_ROLES, SEAT_ROLE_LABELS, SEAT_ROLES } from "./config.ts";
import {
	ATTACHED_STATES,
	cloneAgent,
	cloneSeat,
	defaultSeatRecord,
	normalizeSeatName,
	RECOVERABLE_STATES,
	seatSort,
	tailSnippet,
	TERMINAL_STATES,
} from "./registry-helpers.ts";
import type {
	AgentLifecycleState,
	AgentRecord,
	BatchRecord,
	ICRole,
	NotificationMode,
	RegistryEvent,
	ReturnMode,
	RosterAssignmentRecord,
	RosterRoleSummary,
	RosterSeatRecord,
	SeatRole,
} from "./types.ts";

export class DoeRegistryBase extends EventEmitter {
	protected readonly agents = new Map<string, AgentRecord>();
	protected readonly batches = new Map<string, BatchRecord>();
	protected readonly seats = new Map<string, RosterSeatRecord>();
	protected readonly agentWaiters = new Map<string, Array<(agent: AgentRecord) => void>>();
	protected readonly batchWaiters = new Map<string, Array<(agents: AgentRecord[]) => void>>();
	protected nextContractorNumber = 1;

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

	assignSeat(
		input: {
			agentId: string;
			ic?: string | null;
			role?: string | null;
			model?: string | null;
		},
	): RosterSeatRecord {
		const requestedIc = input.ic?.trim() || null;
		const requestedRole = typeof input.role === "string" ? input.role.trim() : null;
		const validatedRole = this.resolveRequestedRole(requestedRole);
		if (!requestedIc && !requestedRole) {
			throw new Error("Seat assignment requires either an explicit IC or an explicit role.");
		}
		let seat = requestedIc
			? this.requireSeatForAssignment(requestedIc)
			: this.allocateSeat(validatedRole, input.model ?? null);
		if (seat.role === "contractor") {
			if (!requestedRole) {
				throw new Error("Contractor assignments require an explicit role.");
			}
			if (!input.model) {
				throw new Error("Contractor assignments require an explicit model.");
			}
			seat = { ...seat, model: input.model };
		}
		if (seat.role !== "contractor" && requestedRole && requestedRole !== seat.role) {
			throw new Error(`${seat.name} is a ${seat.role} seat, not ${requestedRole}.`);
		}
		if (seat.activeAgentId && seat.activeAgentId !== input.agentId) {
			throw new Error(`${seat.name} already has an active assignment.`);
		}
		const next = { ...seat, activeAgentId: input.agentId };
		this.seats.set(normalizeSeatName(next.name), next);
		this.emitChange();
		return cloneSeat(next);
	}
	private resolveRequestedRole(role: string | null): ICRole | null {
		if (!role) {
			return null;
		}
		if (role === "researcher" || role === "senior" || role === "mid") {
			return role;
		}
		throw new Error(`Unknown IC role "${role}". Use one of: ${IC_ROLES.join(", ")}.`);
	}
	upsertAgent(agent: AgentRecord): AgentRecord {
		const previous = this.agents.get(agent.id);
		const next = cloneAgent(agent);
		this.agents.set(agent.id, next);
		this.syncSeatLinks(previous, next);
		const current = next;
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
			if (agent.threadId === threadId) { return cloneAgent(agent); }
		}
		return undefined;
	}

	findSeat(name: string): RosterSeatRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		return seat ? cloneSeat(seat) : undefined;
	}

	findActiveSeatAgent(name: string): AgentRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat?.activeAgentId) { return undefined; }
		return this.getAgent(seat.activeAgentId);
	}

	findLastFinishedSeatAgent(name: string): AgentRecord | undefined {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat?.lastFinishedAgentId) { return undefined; }
		return this.getAgent(seat.lastFinishedAgentId);
	}

	findAgent(identifier: string): AgentRecord | undefined {
		const seatMatch = this.findActiveSeatAgent(identifier)
			?? this.findLastFinishedSeatAgent(identifier);
		if (seatMatch) { return seatMatch; }
		const exact = this.getAgent(identifier) ?? this.getAgentByThreadId(identifier);
		if (exact) { return exact; }
		const normalized = identifier.trim().toLowerCase();
		for (const agent of this.agents.values()) {
			if (agent.name.trim().toLowerCase() === normalized) { return cloneAgent(agent); }
		}
		return undefined;
	}

	getBatch(id: string): BatchRecord | undefined {
		const batch = this.batches.get(id);
		return batch ? { ...batch, agentIds: [...batch.agentIds] } : undefined;
	}

	listAgents(
		options: { includeCompleted?: boolean; limit?: number; state?: AgentLifecycleState } = {},
	): AgentRecord[] {
		const { includeCompleted = true, limit, state } = options;
		let agents = [...this.agents.values()];
		agents = agents.filter((agent) => {
			if (state && agent.state !== state) { return false; }
			if (!includeCompleted && TERMINAL_STATES.has(agent.state)) { return false; }
			return true;
		});
		agents.sort((a, b) => b.startedAt - a.startedAt);
		if (typeof limit === "number") { agents = agents.slice(0, limit); }
		return agents.map(cloneAgent);
	}

	listRecoverableAgents(): AgentRecord[] {
		return this.listAgents({ includeCompleted: true }).filter((agent) =>
			agent.threadId && RECOVERABLE_STATES.has(agent.state)
		);
	}

	listBatches(limit?: number): BatchRecord[] {
		let batches = [...this.batches.values()].sort((a, b) => b.startedAt - a.startedAt);
		if (typeof limit === "number") { batches = batches.slice(0, limit); }
		return batches.map((batch) => ({ ...batch, agentIds: [...batch.agentIds] }));
	}

	listRosterSeats(): RosterSeatRecord[] {
		return [...this.seats.values()].sort(seatSort).map(cloneSeat);
	}

	listRosterAssignments(
		options: { includeAwaitingInput?: boolean; includeHistory?: boolean; limit?: number } = {},
	): RosterAssignmentRecord[] {
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
				if (history) { entries.push({ seat, agent: history, source: "history" }); }
			}
		}
		return typeof limit === "number" ? entries.slice(0, limit) : entries;
	}

	getRosterRoleSummaries(
		options: { includeAwaitingInput?: boolean; includeHistory?: boolean } = {},
	): RosterRoleSummary[] {
		const counts = new Map<SeatRole, RosterRoleSummary>();
		for (const role of SEAT_ROLES) {
			counts.set(role, { role, label: SEAT_ROLE_LABELS[role], activeCount: 0, names: [] });
		}
		for (
			const entry of this.listRosterAssignments({
				includeAwaitingInput: options.includeAwaitingInput ?? true,
				includeHistory: options.includeHistory ?? false,
			})
		) {
			const summary = counts.get(entry.seat.role);
			if (!summary) {
				continue;
			}
			summary.activeCount += 1;
			summary.names.push(entry.seat.name);
		}
		return [...SEAT_ROLES]
			.map((role) => counts.get(role))
			.filter((summary): summary is RosterRoleSummary => summary !== undefined);
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

		const finalized = this.buildFinalizedAgent(agent, {
			completedAt: agent.completedAt ?? Date.now(),
			note: input.note,
			reuseSummary: input.reuseSummary,
		});
		this.releaseFinalizedAgent(finalized);
		const saved = this.upsertAgent(finalized);
		return { seat: this.requireSeat(seat.name), agent: saved };
	}

	cancelAgent(
		agentId: string,
		input: {
			note?: string | null;
			interruptedTurnId?: string | null;
			reuseSummary?: string | null;
		} = {},
	): AgentRecord {
		const agent = this.agents.get(agentId);
		if (!agent) {
			throw new Error(`Unknown agent "${agentId}".`);
		}
		const finalized = this.buildFinalizedAgent(agent, {
			completedAt: Date.now(),
			interruptedTurnId: input.interruptedTurnId,
			note: input.note,
			reuseSummary: input.reuseSummary,
		});
		this.releaseFinalizedAgent(finalized);
		return this.upsertAgent(finalized);
	}

	protected releaseFinalizedAgent(finalized: AgentRecord) {
		this.releaseSeat(finalized, {
			note: finalized.finishNote ?? null,
			reuseSummary: finalized.reuseSummary ?? null,
		});
	}

	protected buildFinalizedAgent(
		agent: AgentRecord,
		input: {
			completedAt: number;
			interruptedTurnId?: string | null;
			note?: string | null;
			reuseSummary?: string | null;
		},
	): AgentRecord {
		return {
			...cloneAgent(agent),
			state: "finalized",
			activityLabel: "completed",
			activeTurnId: null,
			completedAt: input.completedAt,
			interruptedTurnId: input.interruptedTurnId ?? agent.interruptedTurnId ?? null,
			finishNote: input.note ?? agent.finishNote ?? null,
			reuseSummary: input.reuseSummary ?? agent.reuseSummary ?? null,
			latestSnippet: input.note ? tailSnippet(input.note) : agent.latestSnippet,
		};
	}

	protected resetRoster() {
		this.seats.clear();
		for (const ic of IC_CONFIG) {
			this.seats.set(
				normalizeSeatName(ic.name),
				defaultSeatRecord({ name: ic.name, role: ic.role, model: ic.defaults.model }),
			);
		}
		this.nextContractorNumber = 1;
	}

	protected requireSeat(name: string): RosterSeatRecord {
		const seat = this.seats.get(normalizeSeatName(name));
		if (!seat) { throw new Error(`Unknown IC seat "${name}".`); }
		return cloneSeat(seat);
	}

	protected requireSeatForAssignment(name: string): RosterSeatRecord {
		const seat = this.requireSeat(name);
		if (seat.activeAgentId) {
			const agent = this.agents.get(seat.activeAgentId);
			if (!agent) {
				throw new Error(`${seat.name} already has an occupied assignment.`);
			}
			if (agent.state === "completed") {
				throw new Error(
					`${seat.name} is occupied by a completed assignment. Use codex_resume to continue that thread, or codex_finalize to release the seat before spawning fresh work.`,
				);
			}
			if (agent.state === "awaiting_input") {
				throw new Error(
					`${seat.name} is occupied by an assignment awaiting DOE input. Use codex_resume to continue that thread, or codex_finalize to release the seat before spawning fresh work.`,
				);
			}
			if (agent.state === "working") {
				throw new Error(
					`${seat.name} is occupied by active work. Use codex_resume to continue that thread, or wait/cancel before replacing it.`,
				);
			}
			throw new Error(`${seat.name} already has an occupied assignment.`);
		}
		return seat;
	}

	protected allocateSeat(role: ICRole | null, model: string | null): RosterSeatRecord {
		if (!role) {
			throw new Error("Seat assignment requires an explicit role.");
		}
		const named = this.listRosterSeats().find((seat) => seat.role === role && !seat.activeAgentId);
		if (named) { return named; }
		const contractor = this.listRosterSeats().find((seat) =>
			seat.role === "contractor" && !seat.activeAgentId
		);
		if (contractor) {
			if (!model) {
				throw new Error("Contractor assignments require an explicit model.");
			}
			const next = { ...contractor, model };
			this.seats.set(normalizeSeatName(next.name), next);
			return cloneSeat(next);
		}
		if (!model) {
			throw new Error("Contractor assignments require an explicit model.");
		}
		const seat = defaultSeatRecord({
			name: `contractor-${this.nextContractorNumber}`,
			role: "contractor",
			model,
		});
		this.nextContractorNumber += 1;
		this.seats.set(normalizeSeatName(seat.name), seat);
		return cloneSeat(seat);
	}

	protected releaseSeat(
		agent: AgentRecord,
		input: { note?: string | null; reuseSummary?: string | null } = {},
	) {
		if (!agent.seatName) { return; }
		const key = normalizeSeatName(agent.seatName);
		const seat = this.seats.get(key);
		if (!seat) { return; }
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

	protected syncSeatLinks(previous: AgentRecord | undefined, next: AgentRecord) {
		if (previous?.seatName && previous.seatName !== next.seatName) {
			const previousSeat = this.seats.get(normalizeSeatName(previous.seatName));
			if (previousSeat?.activeAgentId === previous.id) {
				this.seats.set(normalizeSeatName(previous.seatName), {
					...previousSeat,
					activeAgentId: null,
				});
			}
		}
		if (!next.seatName) { return; }
		const key = normalizeSeatName(next.seatName);
		const seat = this.seats.get(key);
		if (!seat) { return; }
		const nextSeat = { ...seat };
		next.name = seat.name;
		next.seatRole = seat.role;
		if (ATTACHED_STATES.has(next.state)) {
			nextSeat.activeAgentId = next.id;
			this.seats.set(key, nextSeat);
			return;
		}
		if (nextSeat.activeAgentId === next.id) { nextSeat.activeAgentId = null; }
		nextSeat.lastFinishedAgentId = next.id;
		nextSeat.lastThreadId = next.threadId ?? nextSeat.lastThreadId ?? null;
		nextSeat.lastFinishNote = next.finishNote ?? nextSeat.lastFinishNote ?? null;
		nextSeat.lastReuseSummary = next.reuseSummary ?? nextSeat.lastReuseSummary ?? null;
		this.seats.set(key, nextSeat);
	}

	protected updateAgent(agentId: string, updater: (agent: AgentRecord) => AgentRecord) {
		const current = this.agents.get(agentId);
		if (!current) { return; }
		this.upsertAgent(updater(cloneAgent(current)));
	}

	protected updateAgentByThread(threadId: string, updater: (agent: AgentRecord) => AgentRecord) {
		for (const agent of this.agents.values()) {
			if (agent.threadId === threadId) {
				this.upsertAgent(updater(cloneAgent(agent)));
				return;
			}
		}
	}

	protected resolveAgent(agent: AgentRecord) {
		const waiters = this.agentWaiters.get(agent.id) ?? [];
		this.agentWaiters.delete(agent.id);
		for (const waiter of waiters) { waiter(cloneAgent(agent)); }
		this.emit("event",
			{ type: "agent-terminal", agent: cloneAgent(agent) } satisfies RegistryEvent);
	}
	protected checkBatchCompletion(batchId?: string) {
		if (!batchId) { return; }
		const batch = this.batches.get(batchId);
		if (!batch) { return; }
		if (batch.completedAt) { return; }
		const agents = batch.agentIds
			.map((id) => this.agents.get(id))
			.filter((agent): agent is AgentRecord => agent !== undefined);
		if (agents.length === 0) { return; }
		if (!agents.every((agent) => TERMINAL_STATES.has(agent.state))) { return; }
		const nextBatch = { ...batch, completedAt: Date.now() };
		this.batches.set(batch.id, nextBatch);
		const waiters = this.batchWaiters.get(batch.id) ?? [];
		this.batchWaiters.delete(batch.id);
		for (const waiter of waiters) { waiter(agents.map(cloneAgent)); }
		this.emit("event", {
			type: "batch-completed",
			batch: { ...nextBatch, agentIds: [...nextBatch.agentIds] },
			agents: agents.map(cloneAgent),
		} satisfies RegistryEvent);
	}

	protected emitChange() {
		this.emit("event", { type: "change" } satisfies RegistryEvent);
	}
}
