import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface DoePlanReviewResult {
	status: "approved" | "needs_revision";
	feedback: string | null;
}

interface PlannotatorReviewOutput {
	hookSpecificOutput?: {
		decision?: {
			behavior?: string;
			message?: string;
		};
	};
}

function isPlannotatorOutput(value: unknown): value is PlannotatorReviewOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return true;
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
	const output = parsed;

	const behavior = output.hookSpecificOutput?.decision?.behavior;
	if (behavior === "allow") {
		return {
			status: "approved",
			feedback: null,
		};
	}

	if (behavior === "deny") {
		return {
			status: "needs_revision",
			feedback: output.hookSpecificOutput?.decision?.message ?? "",
		};
	}

	throw new Error("Plannotator review output did not include a decision.");
}

export function buildPlannotatorRequest(planFilePath: string): string {
	return JSON.stringify({
		tool_input: {
			plan: readFileSync(planFilePath, "utf-8"),
		},
	});
}

export async function runPlanReviewCli(input: {
	planFilePath: string;
	cwd: string;
	signal?: AbortSignal;
}): Promise<DoePlanReviewResult> {
	const payload = buildPlannotatorRequest(input.planFilePath);

	return new Promise((resolve, reject) => {
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

		const cleanup = () => {
			input.signal?.removeEventListener("abort", handleAbort);
		};

		const finish = (handler: () => void) => {
			if (settled) { return; }
			settled = true;
			cleanup();
			handler();
		};

		const handleAbort = () => {
			child.kill("SIGTERM");
			finish(() =>
				reject(new Error("Plannotator review was cancelled before a decision was captured."))
			);
		};

		input.signal?.addEventListener("abort", handleAbort, { once: true });

		child.stdin.write(payload);
		child.stdin.end();
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
					try {
						resolve(parsePlannotatorReviewResult(stdout));
						return;
					} catch (error) {
						reject(
							new Error(
								`Plannotator review returned an invalid decision: ${
									error instanceof Error ? error.message : String(error)
								}`,
							),
						);
						return;
					}
					return;
				}
				const reason = stderr.trim() || stdout.trim()
					|| `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
				reject(new Error(`Plannotator CLI review failed: ${reason}`));
			});
		});
	});
}
