import { spawn } from "node:child_process";

const PLAN_APPROVED_FEEDBACK = "No feedback provided.";

export interface DoePlanReviewResult {
	status: "approved" | "needs_revision";
	feedback: string | null;
}

export function parsePlanReviewResult(stdout: string): DoePlanReviewResult {
	const feedback = stdout.trim();
	if (!feedback || feedback === PLAN_APPROVED_FEEDBACK) {
		return {
			status: "approved",
			feedback: null,
		};
	}
	return {
		status: "needs_revision",
		feedback,
	};
}

export async function runPlanReviewCli(input: {
	planFilePath: string;
	cwd: string;
	signal?: AbortSignal;
}): Promise<DoePlanReviewResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("plannotator", ["annotate", input.planFilePath], {
			cwd: input.cwd,
			env: {
				...process.env,
				PLANNOTATOR_CWD: input.cwd,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const cleanup = () => {
			input.signal?.removeEventListener("abort", handleAbort);
		};

		const finish = (handler: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			handler();
		};

		const handleAbort = () => {
			child.kill("SIGTERM");
			finish(() => reject(new Error("Plannotator review was cancelled before a decision was captured.")));
		};

		input.signal?.addEventListener("abort", handleAbort, { once: true });

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			finish(() => reject(new Error(`Failed to start Plannotator CLI: ${error.message}`)));
		});
		child.on("close", (code, signal) => {
			finish(() => {
				if (code === 0) {
					resolve(parsePlanReviewResult(stdout));
					return;
				}
				const reason = stderr.trim() || stdout.trim() || `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
				reject(new Error(`Plannotator CLI review failed: ${reason}`));
			});
		});
	});
}
