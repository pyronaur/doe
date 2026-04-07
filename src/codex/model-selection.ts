import type { ReasoningEffort } from "./client.ts";

const REASONING_SUFFIX_RE = /^(.*?)-(low|medium|high|xhigh)$/;

export function validateModelId(model: string, context = "model"): string {
	const trimmed = model.trim();
	if (!trimmed) {
		throw new Error(`Invalid ${context}. Model must be a non-empty string.`);
	}
	const suffixMatch = trimmed.match(REASONING_SUFFIX_RE);
	if (suffixMatch) {
		const baseModel = suffixMatch[1]?.trim() || "<base-model>";
		const effort: ReasoningEffort = suffixMatch[2] ?? "medium";
		throw new Error(
			`Invalid ${context} "${trimmed}". Model and reasoning level must be specified separately. Use model: "${baseModel}" and effort: "${effort}".`,
		);
	}
	return trimmed;
}

export function readOptionalModelId(value: unknown, context = "model"): string | null {
	if (typeof value !== "string") { return null; }
	const trimmed = value.trim();
	if (!trimmed) { return null; }
	return validateModelId(trimmed, context);
}
