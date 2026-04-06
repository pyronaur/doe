export const DOE_PLAN_STATE_TYPE = "doe-plan-state";
export const DOE_PLAN_STATE_VERSION = 1;

export interface DoeActivePlanState {
	planSlug: string;
	planFilePath: string;
	agentId: string | null;
	threadId: string | null;
	startedAt: number;
}

export interface DoePendingReviewState {
	planSlug: string;
	reviewId: string | null;
	requestedAt: number;
}

export interface DoePlanState {
	version: number;
	sessionSlugReminderSentAtTurn: number | null;
	activePlan: DoeActivePlanState | null;
	pendingReview: DoePendingReviewState | null;
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
		agentId: asString(input.agentId),
		threadId: asString(input.threadId),
		startedAt,
	};
}

function normalizePendingReviewState(value: unknown): DoePendingReviewState | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const planSlug = asString(input.planSlug);
	const requestedAt = asFiniteNumber(input.requestedAt);
	if (!planSlug || requestedAt === null) return null;
	return {
		planSlug,
		reviewId: asString(input.reviewId),
		requestedAt,
	};
}

export function createEmptyPlanState(): DoePlanState {
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: null,
		activePlan: null,
		pendingReview: null,
	};
}

export function clonePlanState(state: DoePlanState): DoePlanState {
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: state.sessionSlugReminderSentAtTurn ?? null,
		activePlan: state.activePlan ? { ...state.activePlan } : null,
		pendingReview: state.pendingReview ? { ...state.pendingReview } : null,
	};
}

export function normalizePlanState(value: unknown): DoePlanState {
	if (!value || typeof value !== "object") return createEmptyPlanState();
	const input = value as Record<string, unknown>;
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: asFiniteNumber(input.sessionSlugReminderSentAtTurn),
		activePlan: normalizeActivePlanState(input.activePlan),
		pendingReview: normalizePendingReviewState(input.pendingReview),
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
