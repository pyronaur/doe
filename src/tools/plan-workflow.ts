import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import type { DoePlanReviewResult } from "../plan/review.ts";
import type { DoePlanState } from "../plan/session-state.ts";
import type { DoeRegistry } from "../roster/registry.ts";

type ActivePlanState = NonNullable<DoePlanState["activePlan"]>;
type MatchActivePlan = (activePlan: ActivePlanState) => boolean;

export interface PlanWorkflowToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	reviewPlan: (
		input: { planFilePath: string; cwd: string; signal?: AbortSignal },
	) => Promise<DoePlanReviewResult>;
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
