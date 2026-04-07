import type { ReasoningEffort } from "../codex/client.ts";
import { readOptionalModelId } from "../codex/model-selection.ts";
import {
	injectSharedKnowledgebaseContext,
	type SharedKnowledgebaseContext,
} from "../plan/flow.ts";
import { loadMarkdownDocs, type MarkdownDoc, renderMarkdownTemplate } from "../templates/loader.ts";

function asReasoningEffort(value: unknown): ReasoningEffort | null {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh"
		? value
		: null;
}

function unknownTemplateError(
	template: string,
	docs: MarkdownDoc[],
	customMessage?: (templateName: string, docs: MarkdownDoc[]) => string,
): string {
	if (customMessage) {
		return customMessage(template, docs);
	}
	return `Unknown template "${template}".`;
}

export interface TemplatePromptInfo {
	templateName: string | null;
	prompt: string;
	templateDefaultModel: string | null;
	templateDefaultEffort: ReasoningEffort | null;
}

export function buildTemplatePrompt(input: {
	template: string | null | undefined;
	prompt: string;
	templatesDir: string;
	templateVariables?: Record<string, unknown> | undefined;
	extraVariables?: Record<string, unknown> | undefined;
	sharedContext: SharedKnowledgebaseContext | null;
	unknownTemplateMessage?: ((templateName: string, docs: MarkdownDoc[]) => string) | undefined;
}): TemplatePromptInfo {
	const templateName = input.template?.trim();
	if (!templateName) {
		return {
			templateName: null,
			prompt: injectSharedKnowledgebaseContext(input.prompt, input.sharedContext),
			templateDefaultModel: null,
			templateDefaultEffort: null,
		};
	}

	const docs = loadMarkdownDocs(input.templatesDir);
	const doc = docs.find((entry) => entry.name === templateName);
	if (!doc) {
		throw new Error(unknownTemplateError(templateName, docs, input.unknownTemplateMessage));
	}

	const defaultModel = readOptionalModelId(
		doc.attributes.default_model,
		`template "${doc.name}" default_model`,
	);
	const defaultEffort = asReasoningEffort(doc.attributes.default_effort);
	if (!defaultEffort) {
		throw new Error(
			`Template "${doc.name}" must define default_effort as one of: low, medium, high, xhigh.`,
		);
	}

	const variables = {
		task: input.prompt,
		...input.extraVariables,
		...input.templateVariables,
	};
	const usesTaskPlaceholder = doc.body.includes("{{task}}");
	const rendered = renderMarkdownTemplate(doc, variables).trim();
	const prompt = usesTaskPlaceholder || !input.prompt
		? rendered
		: `${rendered}\n\n# Task\n${input.prompt}`;

	return {
		templateName: doc.name,
		prompt: injectSharedKnowledgebaseContext(prompt, input.sharedContext),
		templateDefaultModel: defaultModel,
		templateDefaultEffort: defaultEffort,
	};
}
