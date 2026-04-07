import { IC_CONFIG } from "./config.js";
import type { PersistedRegistrySnapshot, PersistedRosterSnapshot, RosterSeatRecord } from "./types.js";
import { DoeRegistryRuntime } from "./registry-runtime.js";
import {
	cloneAgent,
	contractorNumber,
	defaultSeatRecord,
	findICConfigByName,
	isAttachedState,
	normalizeAgentRecord,
	normalizeSeatName,
} from "./registry-helpers.js";

export class DoeRegistry extends DoeRegistryRuntime {
	serialize(): PersistedRegistrySnapshot {
		return {
			version: 6,
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

	private restoreRoster(roster: PersistedRosterSnapshot) {
		this.resetRoster();
		for (const storedSeat of roster.seats ?? []) {
			const seat = storedSeat as RosterSeatRecord;
			const normalizedName = normalizeSeatName(seat.name);
			const ic = findICConfigByName(seat.name);
			if (ic) {
				this.seats.set(normalizedName, {
					...defaultSeatRecord({ name: ic.name, role: ic.role }),
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
			this.seats.set(normalizedName, {
				...defaultSeatRecord({
					name: `contractor-${number}`,
					role: "contractor",
				}),
				activeAgentId: seat.activeAgentId ?? null,
				lastFinishedAgentId: seat.lastFinishedAgentId ?? null,
				lastThreadId: seat.lastThreadId ?? null,
				lastFinishNote: seat.lastFinishNote ?? null,
				lastReuseSummary: seat.lastReuseSummary ?? null,
			});
		}
		const highestSeen = Math.max(0, ...this.listRosterSeats().map((seat) => contractorNumber(seat.name) ?? 0));
		this.nextContractorNumber = Math.max(roster.nextContractorNumber ?? 1, highestSeen + 1);
	}

	private migrateLegacyRosterLinks() {
		for (const ic of IC_CONFIG) {
			const agent = [...this.agents.values()].find(
				(entry) =>
					entry.name === ic.name &&
					!entry.seatName &&
					isAttachedState(entry.state) &&
					!(this.seats.get(normalizeSeatName(ic.name))?.activeAgentId),
			);
			if (!agent) continue;
			const nextSeat = {
				...this.seats.get(normalizeSeatName(ic.name))!,
				activeAgentId: agent.id,
			};
			this.seats.set(normalizeSeatName(ic.name), nextSeat);
			this.agents.set(agent.id, {
				...cloneAgent(agent),
				name: ic.name,
				seatName: ic.name,
				seatRole: ic.role,
			});
		}
	}

	private normalizeRosterState() {
		for (const agent of this.agents.values()) {
			if (!agent.seatName) continue;
			const key = normalizeSeatName(agent.seatName);
			const existing = this.seats.get(key);
			if (!existing) {
				const ic = findICConfigByName(agent.seatName);
				if (ic) {
					this.seats.set(key, defaultSeatRecord({ name: ic.name, role: ic.role }));
					continue;
				}
				const number = contractorNumber(agent.seatName);
				if (number === null) continue;
				this.seats.set(key, defaultSeatRecord({ name: `contractor-${number}`, role: "contractor" }));
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
				seatRole: seat.role,
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

		const highestSeen = Math.max(0, ...this.listRosterSeats().map((seat) => contractorNumber(seat.name) ?? 0));
		this.nextContractorNumber = Math.max(this.nextContractorNumber, highestSeen + 1);
	}
}
