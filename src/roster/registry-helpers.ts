import { IC_CONFIG, SEAT_ROLES } from "./config.js";
import type { AgentCompactionState } from "../context-usage.js";
import { summarizeErrorText } from "../error-text.js";
import type {
	AgentLifecycleState,
	AgentMessageRecord,
	AgentRecord,
	ICConfig,
	RosterSeatRecord,
	SeatRole,
} from "./types.js";

export const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "error", "awaiting_input", "finalized"]);
const ATTACHED_STATES = new Set<AgentLifecycleState>(["working", "awaiting_input", "completed"]);
const RECOVERABLE_STATES = new Set<AgentLifecycleState>(["working", "awaiting_input"]);
const CONTRACTOR_NAME = /^contractor-(\d+)$/i;

export function normalizeErrorText(text: unknown): string {
	return summarizeErrorText(text);
}

export function normalizeSeatName(name: string): string {
	return name.trim().toLowerCase();
}

const IC_CONFIG_BY_NAME = new Map(IC_CONFIG.map((ic) => [normalizeSeatName(ic.name), ic]));
const IC_DISPLAY_ORDER = new Map(IC_CONFIG.map((ic, index) => [normalizeSeatName(ic.name), index]));

export function findICConfigByName(name: string): ICConfig | undefined {
	return IC_CONFIG_BY_NAME.get(normalizeSeatName(name));
}

export function contractorNumber(name: string): number | null {
	const match = name.match(CONTRACTOR_NAME);
	if (!match) return null;
	const parsed = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function defaultSeatRecord(input: { name: string; role: SeatRole }): RosterSeatRecord {
	return {
		name: input.name,
		role: input.role,
		activeAgentId: null,
		lastFinishedAgentId: null,
		lastThreadId: null,
		lastFinishNote: null,
		lastReuseSummary: null,
	};
}

export function cloneSeat(seat: RosterSeatRecord): RosterSeatRecord {
	return {
		...seat,
		activeAgentId: seat.activeAgentId ?? null,
		lastFinishedAgentId: seat.lastFinishedAgentId ?? null,
		lastThreadId: seat.lastThreadId ?? null,
		lastFinishNote: seat.lastFinishNote ?? null,
		lastReuseSummary: seat.lastReuseSummary ?? null,
	};
}

export function seatSort(a: RosterSeatRecord, b: RosterSeatRecord): number {
	const roleDiff = SEAT_ROLES.indexOf(a.role) - SEAT_ROLES.indexOf(b.role);
	if (roleDiff !== 0) return roleDiff;
	const displayOrderA = IC_DISPLAY_ORDER.get(normalizeSeatName(a.name));
	const displayOrderB = IC_DISPLAY_ORDER.get(normalizeSeatName(b.name));
	if (typeof displayOrderA === "number" && typeof displayOrderB === "number") {
		return displayOrderA - displayOrderB;
	}
	const contractorA = contractorNumber(a.name);
	const contractorB = contractorNumber(b.name);
	if (contractorA !== null && contractorB !== null && contractorA !== contractorB) {
		return contractorA - contractorB;
	}
	return a.name.localeCompare(b.name);
}

export function tailSnippet(text: string, maxChars = 1800, maxLines = 12): string {
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

export function cloneMessage(message: AgentMessageRecord): AgentMessageRecord {
	return { ...message, completedAt: message.completedAt ?? null };
}

export function cloneAgent(agent: AgentRecord): AgentRecord {
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
		seatRole: agent.seatRole ?? null,
		runStartedAt: agent.runStartedAt ?? agent.startedAt,
		interruptedTurnId: agent.interruptedTurnId ?? null,
		finishNote: agent.finishNote ?? null,
		reuseSummary: agent.reuseSummary ?? null,
	};
}

export function createCompactionState(previous?: AgentCompactionState | null): AgentCompactionState {
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

export function latestAgentSummary(messages: AgentMessageRecord[]): { latestSnippet: string; latestFinalOutput: string | null } | null {
	const lastAgentMessage = [...messages].reverse().find((message) => message.role === "agent" && message.text.trim().length > 0);
	if (!lastAgentMessage) return null;
	return {
		latestSnippet: tailSnippet(lastAgentMessage.text),
		latestFinalOutput: lastAgentMessage.streaming ? null : lastAgentMessage.text,
	};
}

export function isAttachedState(state: AgentLifecycleState): boolean {
	return ATTACHED_STATES.has(state);
}

export function isRecoverableState(state: AgentLifecycleState): boolean {
	return RECOVERABLE_STATES.has(state);
}

export function normalizeAgentRecord(agent: AgentRecord): AgentRecord {
	const legacy = agent as AgentRecord & { seatBucket?: SeatRole | null };
	return {
		...cloneAgent(agent),
		seatRole: agent.seatRole ?? legacy.seatBucket ?? null,
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
		interruptedTurnId: agent.interruptedTurnId ?? null,
	};
}

export function shouldIgnoreInterruptedTerminalUpdate(agent: AgentRecord, turnId?: string | null): boolean {
	if (!agent.interruptedTurnId) return false;
	if (turnId && agent.interruptedTurnId !== turnId) return false;
	return agent.state === "awaiting_input" || agent.state === "finalized";
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
