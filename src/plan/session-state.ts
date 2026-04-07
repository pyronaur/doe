import { isRecord } from "../utils/guards.ts";

export const DOE_PLAN_STATE_TYPE = "doe-plan-state";
export const DOE_PLAN_STATE_VERSION = 5;

export type DoePlanWorkflowStatus = "drafting" | "ready_for_review" | "needs_revision";

export interface DoeActivePlanState {
	sessionSlug: string | null;
	planSlug: string;
	planFilePath: string;
	ic: string | null;
	agentId: string | null;
	threadId: string | null;
	status: DoePlanWorkflowStatus;
	reviewFeedback: string | null;
}

export interface DoePendingReviewState {
	reviewId: string;
	sessionSlug: string | null;
	planSlug: string;
	planFilePath: string;
	agentId: string | null;
	requestedAt: number;
}

export interface DoePlanState {
	version: number;
	sessionSlugReminderSentAtTurn: number | null;
	activePlan: DoeActivePlanState | null;
	pendingReview: DoePendingReviewState | null;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asPlanWorkflowStatus(value: unknown): DoePlanWorkflowStatus | null {
	return value === "drafting" || value === "ready_for_review" || value === "needs_revision"
		? value
		: null;
}

function normalizeActivePlanState(value: unknown): DoeActivePlanState | null {
	if (!isRecord(value)) {
		return null;
	}
	const planSlug = asString(value.planSlug);
	const planFilePath = asString(value.planFilePath);
	if (!planSlug || !planFilePath) {
		return null;
	}
	const reviewFeedback = asString(value.reviewFeedback);
	return {
		sessionSlug: asString(value.sessionSlug),
		planSlug,
		planFilePath,
		ic: asString(value.ic),
		agentId: asString(value.agentId),
		threadId: asString(value.threadId),
		status: asPlanWorkflowStatus(value.status) ?? (reviewFeedback ? "needs_revision" : "drafting"),
		reviewFeedback,
	};
}

function normalizePendingReviewState(value: unknown): DoePendingReviewState | null {
	if (!isRecord(value)) {
		return null;
	}
	const reviewId = asString(value.reviewId);
	const planSlug = asString(value.planSlug);
	const planFilePath = asString(value.planFilePath);
	const requestedAt = asFiniteNumber(value.requestedAt);
	if (!reviewId || !planSlug || !planFilePath || requestedAt === null) {
		return null;
	}
	return {
		reviewId,
		sessionSlug: asString(value.sessionSlug),
		planSlug,
		planFilePath,
		agentId: asString(value.agentId),
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

export function serializePlanState(state: DoePlanState): DoePlanState {
	const next = clonePlanState(state);
	next.version = DOE_PLAN_STATE_VERSION;
	return next;
}

export function normalizePlanState(value: unknown): DoePlanState {
	if (!isRecord(value)) {
		return createEmptyPlanState();
	}
	return {
		version: DOE_PLAN_STATE_VERSION,
		sessionSlugReminderSentAtTurn: asFiniteNumber(value.sessionSlugReminderSentAtTurn),
		activePlan: normalizeActivePlanState(value.activePlan),
		pendingReview: normalizePendingReviewState(value.pendingReview),
	};
}

export function restoreLatestPlanState(branch: readonly unknown[]): DoePlanState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isRecord(entry)) {
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== DOE_PLAN_STATE_TYPE) {
			continue;
		}
		return normalizePlanState(entry.data);
	}
	return createEmptyPlanState();
}
