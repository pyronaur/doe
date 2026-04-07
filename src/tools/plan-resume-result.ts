import { formatUsageCompact } from "../context-usage.ts";
import { resolveAgentFinalOutput } from "./agent-final-output.ts";
import { formatContextStatusLines } from "./context-status.ts";
import { formatPlanProgressSummary } from "./plan-workflow.ts";

interface PlanResumePendingResultInput {
	agent: any;
	sessionSlug: string;
	planSlug: string;
	planFilePath: string;
	reviewId: string;
	note: string;
	includeFinalOutput?: boolean;
}

interface PlanResumeDraftingResultInput {
	agent: any;
	sessionSlug: string;
	planSlug: string;
	planFilePath: string;
	outcome: {
		action: "steer_queued" | "turn_started";
		threadId: string | null;
		turnId: string | null;
	};
	note: string;
}

export function buildPlanResumePendingResult(input: PlanResumePendingResultInput) {
	const {
		agent,
		sessionSlug,
		planSlug,
		planFilePath,
		reviewId,
		note,
		includeFinalOutput = false,
	} = input;
	const ic = agent?.seatName ?? agent?.name ?? "unknown";
	const lines = [
		`ic: ${ic}`,
		`plan_slug: ${planSlug}`,
		"state: ready_for_review",
		...(agent
			? [
				`context: ${formatUsageCompact(agent.usage)}`,
				...formatContextStatusLines(agent.compaction),
			]
			: []),
		`plan_file: ${planFilePath}`,
		"review_status: pending",
		`review_id: ${reviewId}`,
		"",
		...formatPlanProgressSummary({
			happened: note,
			agent: agent ?? null,
		}),
	];
	if (includeFinalOutput && agent) {
		lines.push("", resolveAgentFinalOutput(agent, "unknown"));
	}
	return {
		content: [{
			type: "text",
			text: lines.join("\n"),
		}],
		details: {
			agent: agent ?? null,
			ic,
			sessionSlug,
			planSlug,
			planFilePath,
			reviewStatus: "pending",
			reviewFeedback: null,
			reviewId,
			happened: note,
			agentResponseAt: agent?.completedAt ?? null,
			lastAgentMessage: resolveAgentFinalOutput(agent, "unknown"),
		},
	};
}

export function buildPlanResumeDraftingResult(input: PlanResumeDraftingResultInput) {
	const { agent, sessionSlug, planSlug, planFilePath, outcome, note } = input;
	const ic = agent?.seatName ?? agent?.name ?? "unknown";
	return {
		content: [{
			type: "text",
			text: [
				`ic: ${ic}`,
				`plan_slug: ${planSlug}`,
				"state: drafting",
				...(agent
					? [
						`context: ${formatUsageCompact(agent.usage)}`,
						...formatContextStatusLines(agent.compaction),
					]
					: []),
				`plan_file: ${planFilePath}`,
				`action: ${outcome.action}`,
				`thread_id: ${outcome.threadId ?? "unknown"}`,
				`turn_id: ${outcome.turnId ?? "unknown"}`,
				"",
				...formatPlanProgressSummary({
					happened: note,
					agent: agent ?? null,
				}),
			].join("\n"),
		}],
		details: {
			agent: agent ?? null,
			ic,
			sessionSlug,
			planSlug,
			planFilePath,
			reviewStatus: null,
			reviewFeedback: null,
			reviewId: null,
			action: outcome.action,
			threadId: outcome.threadId,
			turnId: outcome.turnId,
			happened: note,
			agentResponseAt: agent?.completedAt ?? null,
			lastAgentMessage: resolveAgentFinalOutput(agent, "unknown"),
		},
	};
}
