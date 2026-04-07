import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export interface DoePlanReviewResult {
	status: "approved" | "needs_revision";
	feedback: string | null;
}

export interface DoePlanReviewJob {
	reviewId: string;
	planFilePath: string;
	cwd: string;
	requestedAt: number;
	wait: Promise<DoePlanReviewResult>;
	cancel: () => void;
}

interface PlannotatorReviewOutput {
	hookSpecificOutput?: {
		decision?: {
			behavior?: string;
			message?: string;
		};
	};
}

interface StartPlanReviewInput {
	reviewId?: string;
	planFilePath: string;
	cwd: string;
}

interface ReviewProcess {
	wait: Promise<DoePlanReviewResult>;
	cancel: () => void;
}

const planReviewJobs = new Map<string, DoePlanReviewJob>();

function isPlannotatorOutput(value: unknown): value is PlannotatorReviewOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return true;
}

function spawnReviewProcess(input: {
	reviewId: string;
	payload: string;
	cwd: string;
}): ReviewProcess {
	let cancel = () => {};
	const wait = new Promise<DoePlanReviewResult>((resolve, reject) => {
		const child = spawn("plannotator", [], {
			cwd: input.cwd,
			env: {
				...process.env,
				PLANNOTATOR_CWD: input.cwd,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (handler: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			planReviewJobs.delete(input.reviewId);
			handler();
		};
		const fail = (message: string) => finish(() => reject(new Error(message)));

		cancel = () => {
			child.kill("SIGTERM");
			fail("Plannotator review was cancelled before a decision was captured.");
		};

		try {
			child.stdin.write(input.payload);
			child.stdin.end();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			fail(`Failed to send plan content to Plannotator CLI: ${reason}`);
			return;
		}

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			fail(`Failed to start Plannotator CLI: ${error.message}`);
		});
		child.on("close", (code, signal) => {
			finish(() => {
				if (code === 0) {
					try {
						resolve(parsePlannotatorReviewResult(stdout));
						return;
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						reject(new Error(`Plannotator review returned an invalid decision: ${reason}`));
						return;
					}
				}
				const reason = stderr.trim() || stdout.trim()
					|| `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
				reject(new Error(`Plannotator CLI review failed: ${reason}`));
			});
		});
	});
	return {
		wait,
		cancel: () => cancel(),
	};
}

export function buildPlannotatorRequest(planFilePath: string): string {
	return JSON.stringify({
		tool_input: {
			plan: readFileSync(planFilePath, "utf-8"),
		},
	});
}

export function parsePlannotatorReviewResult(stdout: string): DoePlanReviewResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw new Error("Plannotator review output was not valid JSON.");
	}
	if (!isPlannotatorOutput(parsed)) {
		throw new Error("Plannotator review output did not include a decision.");
	}
	const behavior = parsed.hookSpecificOutput?.decision?.behavior;
	if (behavior === "allow") {
		return {
			status: "approved",
			feedback: null,
		};
	}
	if (behavior === "deny") {
		return {
			status: "needs_revision",
			feedback: parsed.hookSpecificOutput?.decision?.message ?? "",
		};
	}
	throw new Error("Plannotator review output did not include a decision.");
}

export function getPlanReviewJob(reviewId: string): DoePlanReviewJob | null {
	return planReviewJobs.get(reviewId) ?? null;
}

export const hasPlanReviewJob: (reviewId: string) => boolean = planReviewJobs.has.bind(
	planReviewJobs,
);

export function startPlanReviewCli(input: StartPlanReviewInput): DoePlanReviewJob {
	const reviewId = input.reviewId?.trim() || randomUUID();
	const existing = planReviewJobs.get(reviewId);
	if (existing) {
		return existing;
	}
	const process = spawnReviewProcess({
		reviewId,
		payload: buildPlannotatorRequest(input.planFilePath),
		cwd: input.cwd,
	});
	const job: DoePlanReviewJob = {
		reviewId,
		planFilePath: input.planFilePath,
		cwd: input.cwd,
		requestedAt: Date.now(),
		wait: process.wait,
		cancel: () => process.cancel(),
	};
	planReviewJobs.set(reviewId, job);
	return job;
}

export async function runPlanReviewCli(input: {
	planFilePath: string;
	cwd: string;
	signal?: AbortSignal;
}): Promise<DoePlanReviewResult> {
	const job = startPlanReviewCli({
		planFilePath: input.planFilePath,
		cwd: input.cwd,
	});
	const signal = input.signal;
	if (!signal) {
		return await job.wait;
	}
	if (signal.aborted) {
		job.cancel();
		throw new Error("Plannotator review was cancelled before a decision was captured.");
	}
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			job.cancel();
			cleanup();
			reject(new Error("Plannotator review was cancelled before a decision was captured."));
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		job.wait.then(
			(result) => {
				cleanup();
				resolve(result);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}
