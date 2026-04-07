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
	started: Promise<void>;
	wait: Promise<DoePlanReviewResult>;
	isAlive: () => boolean;
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
	started: Promise<void>;
	wait: Promise<DoePlanReviewResult>;
	cancel: () => void;
}

interface StartupLatch {
	started: Promise<void>;
	settle: (input: { ok: true } | { ok: false; error: Error }) => void;
}

const planReviewJobs = new Map<string, DoePlanReviewJob>();

function isPlannotatorOutput(value: unknown): value is PlannotatorReviewOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return true;
}

function createStartupLatch(): StartupLatch {
	let resolveStarted: (() => void) | null = null;
	let rejectStarted: ((error: Error) => void) | null = null;
	const started = new Promise<void>((resolve, reject) => {
		resolveStarted = resolve;
		rejectStarted = reject;
	});
	const settle = (input: { ok: true } | { ok: false; error: Error }) => {
		if (!resolveStarted || !rejectStarted) {
			return;
		}
		const onResolve = resolveStarted;
		const onReject = rejectStarted;
		resolveStarted = null;
		rejectStarted = null;
		if (input.ok) {
			onResolve();
			return;
		}
		onReject(input.error);
	};
	return { started, settle };
}

function tryWriteReviewPayload(input: {
	payload: string;
	fail: (message: string) => void;
	stdin: { write(chunk: string): void; end(): void };
}): boolean {
	try {
		input.stdin.write(input.payload);
		input.stdin.end();
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		input.fail(`Failed to send plan content to Plannotator CLI: ${reason}`);
		return false;
	}
}

function buildReviewFailureReason(input: {
	stderr: string;
	stdout: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}): string {
	return input.stderr.trim() || input.stdout.trim()
		|| `exit code ${input.code ?? "null"}, signal ${input.signal ?? "null"}`;
}

function handleReviewClose(input: {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	stdout: string;
	resolve: (result: DoePlanReviewResult) => void;
	reject: (error: Error) => void;
	settleStarted: StartupLatch["settle"];
}) {
	if (input.code !== 0) {
		const reason = buildReviewFailureReason({
			stderr: input.stderr,
			stdout: input.stdout,
			code: input.code,
			signal: input.signal,
		});
		input.settleStarted({
			ok: false,
			error: new Error(`Plannotator CLI review failed: ${reason}`),
		});
		input.reject(new Error(`Plannotator CLI review failed: ${reason}`));
		return;
	}

	input.settleStarted({ ok: true });
	try {
		input.resolve(parsePlannotatorReviewResult(input.stdout));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		input.reject(new Error(`Plannotator review returned an invalid decision: ${reason}`));
	}
}

function spawnReviewProcess(input: {
	reviewId: string;
	payload: string;
	cwd: string;
}): ReviewProcess {
	let cancel = () => {};
	const startup = createStartupLatch();
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
		const fail = (message: string) => {
			const error = new Error(message);
			startup.settle({ ok: false, error });
			finish(() => reject(error));
		};

		cancel = () => {
			child.kill("SIGTERM");
			fail("Plannotator review was cancelled before a decision was captured.");
		};

		if (
			!tryWriteReviewPayload({
				payload: input.payload,
				fail,
				stdin: child.stdin,
			})
		) {
			return;
		}

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("spawn", () => {
			startup.settle({ ok: true });
		});
		child.on("error", (error) => {
			fail(`Failed to start Plannotator CLI: ${error.message}`);
		});
		child.on("close", (code, signal) => {
			finish(() => {
				handleReviewClose({
					code,
					signal,
					stderr,
					stdout,
					resolve,
					reject,
					settleStarted: startup.settle,
				});
			});
		});
	});
	return {
		started: startup.started,
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
		started: process.started,
		wait: process.wait,
		isAlive: () => planReviewJobs.get(reviewId) === job,
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
