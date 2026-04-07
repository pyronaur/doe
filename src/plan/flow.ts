import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MarkdownDoc } from "../templates/loader.js";
import { loadMarkdownDocs, renderMarkdownTemplate } from "../templates/loader.js";
import { getPlanFilePath, getSessionWorkspacePath, normalizePlanSlug } from "./slug.js";

export interface SharedKnowledgebaseContext {
	sessionSlug: string;
	sharedKnowledgebasePath: string;
}

export interface PreparedPlanFile {
	planSlug: string;
	planFilePath: string;
	exists: boolean;
	requiresAllowExisting: boolean;
}

function findTemplateDoc(templatesDir: string, templateName: string): MarkdownDoc {
	const doc = loadMarkdownDocs(templatesDir).find((entry) => entry.name === templateName);
	if (!doc) {
		throw new Error(`Unknown template "${templateName}".`);
	}
	return doc;
}

export function getSharedKnowledgebaseContext(repoRoot: string, sessionSlug: string): SharedKnowledgebaseContext {
	return {
		sessionSlug,
		sharedKnowledgebasePath: getSessionWorkspacePath(repoRoot, sessionSlug),
	};
}

export function injectSharedKnowledgebaseContext(prompt: string, context: SharedKnowledgebaseContext | null): string {
	if (!context) return prompt;
	const prefix = [
		"Shared session context:",
		`- Session slug: ${context.sessionSlug}`,
		`- Shared knowledgebase directory: ${context.sharedKnowledgebasePath}`,
		"- Reuse that shared directory for any notes or artifacts that belong to this DoE session.",
	].join("\n");
	return `${prefix}\n\n${prompt}`.trim();
}

export function preparePlanFile(input: {
	repoRoot: string;
	sessionSlug: string;
	planSlug: string;
	allowExisting?: boolean;
}): PreparedPlanFile {
	const planSlug = normalizePlanSlug(input.planSlug);
	const planFilePath = getPlanFilePath(input.repoRoot, input.sessionSlug, planSlug);
	const exists = existsSync(planFilePath);
	return {
		planSlug,
		planFilePath,
		exists,
		requiresAllowExisting: exists && input.allowExisting !== true,
	};
}

export function ensurePlanFile(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, "", "utf-8");
	}
}

export function readPlanFile(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`Plan file was not created: ${path}`);
	}
	const text = readFileSync(path, "utf-8").trim();
	if (!text) {
		throw new Error(`Plan file is empty: ${path}`);
	}
	return text;
}

export function formatPlanReviewCommand(planFilePath: string): string {
	return `!plannotator annotate ${planFilePath}`;
}

export function renderPlanPrompt(input: {
	templatesDir: string;
	task: string;
	planFilePath: string;
	sharedKnowledgebasePath: string;
}): string {
	const doc = findTemplateDoc(input.templatesDir, "plan");
	return renderMarkdownTemplate(doc, {
		task: input.task,
		planFilePath: input.planFilePath,
		sharedKnowledgebasePath: input.sharedKnowledgebasePath,
	}).trim();
}

export function formatPlanReuseError(result: PreparedPlanFile): string {
	return [
		`Plan file already exists: ${result.planFilePath}`,
		"Retry only if this existing plan file should be reused by calling plan_start again with allowExisting=true.",
	].join("\n");
}

export function buildPlanResumePrompt(input: {
	feedback: string;
	commentary?: string;
	planFilePath: string;
	sharedKnowledgebasePath: string;
}): string {
	const commentary = input.commentary?.trim();
	return [
		"Continue the current planning workflow.",
		`Shared knowledgebase directory: ${input.sharedKnowledgebasePath}`,
		`Rewrite the plan only at: ${input.planFilePath}`,
		"Do not choose a different output path.",
		"",
		"# CTO Review Feedback",
		input.feedback.trim(),
		...(commentary ? ["", "# DoE Commentary", commentary] : []),
		"",
		"Revise the plan accordingly and overwrite the same markdown file.",
	].join("\n");
}
