import type { DoeRegistry } from "../roster/registry.ts";
import type { AgentRecord } from "../roster/types.ts";
import {
	attachPlanReviewOutcomeHandler,
	ensurePlanReviewPending,
	type PlanWorkflowToolDeps,
	setPlanReadyWithPendingReview,
	setPlanReviewRetryable,
} from "../tools/plan-workflow.ts";
import { readPlanFile } from "./flow.ts";
import type { DoePlanReviewResult } from "./review.ts";
import type { DoeActivePlanState, DoePendingReviewState, DoePlanState } from "./session-state.ts";

interface PlanReviewCoordinatorDeps {
	registry: DoeRegistry;
	getPlanState: () => DoePlanState;
	setPlanState: PlanWorkflowToolDeps["setPlanState"];
	startReviewPlan: PlanWorkflowToolDeps["startReviewPlan"];
}

function matchesActivePlan(
	activePlan: DoeActivePlanState,
	match: { planSlug: string; planFilePath: string; agentId?: string | null },
): boolean {
	if (activePlan.planSlug !== match.planSlug) {
		return false;
	}
	if (activePlan.planFilePath !== match.planFilePath) {
		return false;
	}
	if (!match.agentId) {
		return true;
	}
	return activePlan.agentId === match.agentId;
}

function buildActivePlanMatcher(activePlan: DoeActivePlanState) {
	return (current: DoeActivePlanState) =>
		matchesActivePlan(current, {
			planSlug: activePlan.planSlug,
			planFilePath: activePlan.planFilePath,
			agentId: activePlan.agentId,
		});
}

function buildPendingReviewMatcher(input: {
	reviewId: string;
	planSlug: string;
	planFilePath: string;
}) {
	return (pending: DoePendingReviewState) =>
		pending.reviewId === input.reviewId
		&& pending.planSlug === input.planSlug
		&& pending.planFilePath === input.planFilePath;
}

export class DoePlanReviewCoordinator {
	private planReviewLaunchKey: string | null = null;
	private readonly watchedPlanReviewIds = new Set<string>();
	private readonly deps: PlanReviewCoordinatorDeps;

	constructor(deps: PlanReviewCoordinatorDeps) {
		this.deps = deps;
	}

	onAgentTerminal(agent: AgentRecord) {
		const state = this.deps.getPlanState();
		const activePlan = state.activePlan;
		if (!activePlan) {
			return;
		}
		if (activePlan.status !== "drafting" || state.pendingReview) {
			return;
		}
		if (agent.state !== "completed") {
			return;
		}
		if (!activePlan.agentId || agent.id !== activePlan.agentId) {
			return;
		}
		void this.launchReviewForDraft(activePlan);
	}

	onRestore() {
		this.restorePendingReviewIfNeeded();
		this.maybeKickReviewAfterRestore();
	}

	private resolveReviewCwd(activePlan: DoeActivePlanState): string {
		const agent = activePlan.agentId ? this.deps.registry.findAgent(activePlan.agentId) : null;
		return agent?.cwd ?? process.cwd();
	}

	private createLaunchKey(activePlan: DoeActivePlanState): string {
		return `${activePlan.planSlug}:${activePlan.planFilePath}:${activePlan.agentId ?? ""}`;
	}

	private claimLaunch(activePlan: DoeActivePlanState): string | null {
		const key = this.createLaunchKey(activePlan);
		if (this.planReviewLaunchKey === key) {
			return null;
		}
		this.planReviewLaunchKey = key;
		return key;
	}

	private releaseLaunch(key: string) {
		if (this.planReviewLaunchKey !== key) {
			return;
		}
		this.planReviewLaunchKey = null;
	}

	private watchReviewOutcome(input: {
		reviewId: string;
		wait: Promise<DoePlanReviewResult>;
		matchActive: (activePlan: DoeActivePlanState) => boolean;
		matchPending: (pendingReview: DoePendingReviewState) => boolean;
	}) {
		if (this.watchedPlanReviewIds.has(input.reviewId)) {
			return;
		}
		this.watchedPlanReviewIds.add(input.reviewId);
		attachPlanReviewOutcomeHandler({
			wait: input.wait,
			reviewId: input.reviewId,
			setPlanState: this.deps.setPlanState,
			matchActive: input.matchActive,
			matchPending: input.matchPending,
		});
		void input.wait.finally(() => {
			this.watchedPlanReviewIds.delete(input.reviewId);
		});
	}

	private async prepareReviewJob(
		activePlan: DoeActivePlanState,
		input: { reviewId?: string },
	): Promise<{
		reviewId: string;
		wait: Promise<DoePlanReviewResult>;
		started?: Promise<void>;
		isAlive?: () => boolean;
	}> {
		readPlanFile(activePlan.planFilePath);
		const reviewJob = this.deps.startReviewPlan({
			reviewId: input.reviewId,
			planFilePath: activePlan.planFilePath,
			cwd: this.resolveReviewCwd(activePlan),
		});
		return {
			reviewId: reviewJob.reviewId,
			wait: reviewJob.wait,
			started: reviewJob.started,
			isAlive: reviewJob.isAlive,
		};
	}

	private persistPendingReview(
		activePlan: DoeActivePlanState,
		reviewId: string,
		requestedAt: number,
	) {
		const pendingReview: DoePendingReviewState = {
			reviewId,
			sessionSlug: activePlan.sessionSlug,
			planSlug: activePlan.planSlug,
			planFilePath: activePlan.planFilePath,
			agentId: activePlan.agentId,
			requestedAt,
		};
		const matchActivePlan = buildActivePlanMatcher(activePlan);
		setPlanReadyWithPendingReview(this.deps.setPlanState, matchActivePlan, pendingReview);
	}

	private async launchReviewForDraft(activePlan: DoeActivePlanState): Promise<void> {
		if (activePlan.status !== "drafting") {
			return;
		}
		if (this.deps.getPlanState().pendingReview) {
			return;
		}
		const launchKey = this.claimLaunch(activePlan);
		if (!launchKey) {
			return;
		}
		try {
			const job = await this.prepareReviewJob(activePlan, {});
			const matchActivePlan = buildActivePlanMatcher(activePlan);
			const matchPendingReview = buildPendingReviewMatcher({
				reviewId: job.reviewId,
				planSlug: activePlan.planSlug,
				planFilePath: activePlan.planFilePath,
			});
			this.persistPendingReview(activePlan, job.reviewId, Date.now());
			try {
				await ensurePlanReviewPending(job);
			} catch (error) {
				setPlanReviewRetryable(this.deps.setPlanState, matchActivePlan, matchPendingReview);
				throw error;
			}
			this.watchReviewOutcome({
				reviewId: job.reviewId,
				wait: job.wait,
				matchActive: matchActivePlan,
				matchPending: matchPendingReview,
			});
		} catch (error) {
			console.error(
				`[doe] failed to start plan review for ${activePlan.planSlug}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			this.releaseLaunch(launchKey);
		}
	}

	private restorePendingReviewIfNeeded() {
		const state = this.deps.getPlanState();
		const pendingReview = state.pendingReview;
		const activePlan = state.activePlan;
		if (!pendingReview || !activePlan) {
			return;
		}
		if (
			!matchesActivePlan(activePlan, {
				planSlug: pendingReview.planSlug,
				planFilePath: pendingReview.planFilePath,
				agentId: pendingReview.agentId,
			})
		) {
			this.deps.setPlanState(
				(current) => ({
					...current,
					pendingReview: null,
				}),
				{ flush: true },
			);
			return;
		}
		const matchActivePlan = buildActivePlanMatcher(activePlan);
		const matchPendingReview = buildPendingReviewMatcher({
			reviewId: pendingReview.reviewId,
			planSlug: pendingReview.planSlug,
			planFilePath: pendingReview.planFilePath,
		});

		let reviewJob:
			| ReturnType<PlanReviewCoordinatorDeps["startReviewPlan"]>
			| null = null;
		try {
			reviewJob = this.deps.startReviewPlan({
				reviewId: pendingReview.reviewId,
				planFilePath: pendingReview.planFilePath,
				cwd: this.resolveReviewCwd(activePlan),
			});
		} catch (error) {
			setPlanReviewRetryable(this.deps.setPlanState, matchActivePlan, matchPendingReview);
			console.error(
				`[doe] failed to restore plan review ${pendingReview.reviewId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}
		this.watchReviewOutcome({
			reviewId: reviewJob.reviewId,
			wait: reviewJob.wait,
			matchActive: matchActivePlan,
			matchPending: matchPendingReview,
		});
		void ensurePlanReviewPending(reviewJob).catch(() => {
			setPlanReviewRetryable(this.deps.setPlanState, matchActivePlan, matchPendingReview);
		});
	}

	private maybeKickReviewAfterRestore() {
		const state = this.deps.getPlanState();
		const activePlan = state.activePlan;
		if (!activePlan || activePlan.status !== "drafting" || state.pendingReview) {
			return;
		}
		if (!activePlan.agentId) {
			return;
		}
		const agent = this.deps.registry.findAgent(activePlan.agentId);
		if (!agent || agent.state !== "completed") {
			return;
		}
		void this.launchReviewForDraft(activePlan);
	}
}
