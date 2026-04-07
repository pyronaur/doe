export const DOE_PLAN_STATE_TYPE = "doe-plan-state";
export const DOE_PLAN_STATE_VERSION = 2;

export interface DoeActivePlanState {
	planSlug: string;
	planFilePath: string;
	ic: string | null;
	agentId: string | null;
	threadId: string | null;
	startedAt: number;
}

export interface DoePlanState {
	version: number;
	sessionSlugReminderSentAtTurn: number | null;
	activePlan: DoeActivePlanState | null;
}

interface CustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeActivePlanState(value: unknown): DoeActivePlanState | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const planSlug = asString(input.planSlug);
	const planFilePath = asString(input.planFilePath);
	const startedAt = asFiniteNumber(input.startedAt);
	if (!planSlug || !planFilePath || startedAt === null) return null;
	return {
		planSlug,
		planFilePath,
		ic: asString(input.ic),
		agentId: asString(input.agentId),
		threadId: asString(input.threadId),
		startedAt,
	};
}

export function createEmptyPlanState(): DoePlanState {
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: null,
		activePlan: null,
	};
}

export function clonePlanState(state: DoePlanState): DoePlanState {
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: state.sessionSlugReminderSentAtTurn ?? null,
		activePlan: state.activePlan ? { ...state.activePlan } : null,
	};
}

export function normalizePlanState(value: unknown): DoePlanState {
	if (!value || typeof value !== "object") return createEmptyPlanState();
	const input = value as Record<string, unknown>;
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: asFiniteNumber(input.sessionSlugReminderSentAtTurn),
		activePlan: normalizeActivePlanState(input.activePlan),
	};
}

export function serializePlanState(state: DoePlanState): DoePlanState {
	return clonePlanState(state);
}

export function restoreLatestPlanState(branch: readonly unknown[]): DoePlanState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as CustomEntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== DOE_PLAN_STATE_TYPE) continue;
		return normalizePlanState(entry.data);
	}
	return createEmptyPlanState();
}
