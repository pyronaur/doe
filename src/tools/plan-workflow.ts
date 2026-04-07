import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import type { DoePlanReviewResult } from "../plan/review.ts";
import type { DoePlanState } from "../plan/session-state.ts";
import type { DoeRegistry } from "../roster/registry.ts";

type ActivePlanState = NonNullable<DoePlanState["activePlan"]>;
type PendingReviewState = NonNullable<DoePlanState["pendingReview"]>;
type MatchActivePlan = (activePlan: ActivePlanState) => boolean;
type MatchPendingReview = (pendingReview: PendingReviewState) => boolean;

export interface PlanWorkflowToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	startReviewPlan: (
		input: { reviewId?: string; planFilePath: string; cwd: string },
	) => { reviewId: string; wait: Promise<DoePlanReviewResult> };
	getSessionSlug: () => string | null;
	getPlanState: () => DoePlanState;
	setPlanState: (
		updater: (state: DoePlanState) => DoePlanState,
		options?: { flush?: boolean },
	) => DoePlanState;
}

function updateActivePlan(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	match: MatchActivePlan,
	update: (activePlan: ActivePlanState) => ActivePlanState | null,
) {
	setPlanState(
		(current) => ({
			...current,
			activePlan: current.activePlan && match(current.activePlan)
				? update(current.activePlan)
				: current.activePlan,
		}),
		{ flush: true },
	);
}

export function formatPlanReviewSummary(review: DoePlanReviewResult): string[] {
	if (!review.feedback) {
		return [];
	}
	return ["", "<review_feedback>", review.feedback, "</review_feedback>"];
}

export function formatPlanRevisionNextStep(review: DoePlanReviewResult): string[] {
	if (review.status !== "needs_revision") {
		return [];
	}
	return [
		"",
		"<next_step>",
		"Review feedback is stored automatically. Use plan_resume with Director commentary only.",
		"</next_step>",
	];
}

export function setPlanReadyForReview(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	match: MatchActivePlan,
) {
	updateActivePlan(setPlanState, match, (activePlan) => ({
		...activePlan,
		status: "ready_for_review",
		reviewFeedback: null,
	}));
}

export function setPlanReviewOutcome(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	match: MatchActivePlan,
	review: DoePlanReviewResult,
) {
	updateActivePlan(setPlanState, match, (activePlan) =>
		review.status === "approved"
			? null
			: {
				...activePlan,
				status: "needs_revision",
				reviewFeedback: review.feedback,
			});
}

export function setPlanPendingReview(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	match: MatchActivePlan,
	pending: PendingReviewState,
) {
	setPlanState(
		(current) => ({
			...current,
			pendingReview: current.activePlan && match(current.activePlan)
				? { ...pending }
				: current.pendingReview,
		}),
		{ flush: true },
	);
}

export function clearPlanPendingReview(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	matchPending: MatchPendingReview,
) {
	setPlanState(
		(current) => ({
			...current,
			pendingReview: current.pendingReview && matchPending(current.pendingReview)
				? null
				: current.pendingReview,
		}),
		{ flush: true },
	);
}

export function applyPlanReviewOutcome(input: {
	setPlanState: PlanWorkflowToolDeps["setPlanState"];
	matchActive: MatchActivePlan;
	matchPending: MatchPendingReview;
	review: DoePlanReviewResult;
}) {
	input.setPlanState(
		(current) => {
			if (!current.pendingReview || !input.matchPending(current.pendingReview)) {
				return current;
			}
			if (!current.activePlan || !input.matchActive(current.activePlan)) {
				return {
					...current,
					pendingReview: null,
				};
			}
			return {
				...current,
				activePlan: input.review.status === "approved"
					? null
					: {
						...current.activePlan,
						status: "needs_revision",
						reviewFeedback: input.review.feedback,
					},
				pendingReview: null,
			};
		},
		{ flush: true },
	);
}

export function setPlanReviewRetryable(
	setPlanState: PlanWorkflowToolDeps["setPlanState"],
	matchActive: MatchActivePlan,
	matchPending: MatchPendingReview,
) {
	setPlanState(
		(current) => {
			if (!current.pendingReview || !matchPending(current.pendingReview)) {
				return current;
			}
			if (!current.activePlan || !matchActive(current.activePlan)) {
				return {
					...current,
					pendingReview: null,
				};
			}
			return {
				...current,
				activePlan: {
					...current.activePlan,
					status: "ready_for_review",
					reviewFeedback: null,
				},
				pendingReview: null,
			};
		},
		{ flush: true },
	);
}

export function attachPlanReviewOutcomeHandler(input: {
	wait: Promise<DoePlanReviewResult>;
	reviewId: string;
	setPlanState: PlanWorkflowToolDeps["setPlanState"];
	matchActive: MatchActivePlan;
	matchPending: MatchPendingReview;
}) {
	void input.wait.then(
		(review) => {
			applyPlanReviewOutcome({
				setPlanState: input.setPlanState,
				matchActive: input.matchActive,
				matchPending: input.matchPending,
				review,
			});
		},
		(error) => {
			setPlanReviewRetryable(input.setPlanState, input.matchActive, input.matchPending);
			console.error(
				`[doe] background plan review ${input.reviewId} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		},
	);
}
