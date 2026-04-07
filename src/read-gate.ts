import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export const READ_TOOL_NAME = "read";
export const NON_IMAGE_READ_BLOCK_REASON = "CTO approval required for non-image reads.";
export const NON_IMAGE_READ_NO_UI_REASON =
	"CTO approval required for non-image reads, but interactive approval is unavailable.";

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

export interface ReadGateInput {
	path: string;
	offset?: number;
	limit?: number;
}

export interface ReadPathClassification {
	kind: "image" | "non-image" | "unknown";
	resolvedPath: string;
	mimeType: string | null;
}

export interface ReadGateDecision {
	block: true;
	reason: string;
}

export interface ReadGateToolResultDecision {
	toolResult: AgentToolResult;
	isError?: boolean;
}

export type ReadGateResult = ReadGateDecision | ReadGateToolResultDecision | null;

interface ResolvePathOptions {
	homeDir?: string;
}

interface ClassifyReadPathOptions extends ResolvePathOptions {}

interface EvaluateReadGateOptions extends ClassifyReadPathOptions {
	cwd: string;
	hasUI: boolean;
	input: ReadGateInput;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	promptInput?: (title: string, placeholder?: string) => Promise<string | undefined>;
}

const APPROVAL_OPTIONS = ["Yes", "No", "No, with reason..."] as const;

function buildNonImageReadApprovalTitle(input: ReadGateInput, classification: ReadPathClassification): string {
	return ["CTO Approval Required", buildNonImageReadApprovalMessage(input, classification)].join("\n\n");
}

function normalizeDenialReason(reason: string | undefined): string {
	const trimmed = reason?.trim();
	return trimmed ? trimmed : NON_IMAGE_READ_BLOCK_REASON;
}

function buildDeniedReadToolResult(reason: string): AgentToolResult {
	return {
		content: [
			{
				type: "text",
				text: [
					"Non-image read denied by CTO.",
					`Reason: ${reason}`,
					"Continue without this read. Choose another route. If clarification is needed, delegate to an IC instead of retrying this gated read.",
				].join("\n"),
			},
		],
	};
}

function normalizeUnicodeSpaces(value: string): string {
	return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function tryMacOsScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	return existsSync(filePath);
}

export function expandReadPath(filePath: string, options: ResolvePathOptions = {}): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	const home = options.homeDir ?? homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/")) return `${home}${normalized.slice(1)}`;
	return normalized;
}

export function resolveReadPathForGate(filePath: string, cwd: string, options: ResolvePathOptions = {}): string {
	const expanded = expandReadPath(filePath, options);
	const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
	if (fileExists(resolved)) return resolved;

	const amPmVariant = tryMacOsScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) return amPmVariant;

	const nfdVariant = tryNfdVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) return nfdVariant;

	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) return curlyVariant;

	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) return nfdCurlyVariant;

	return resolved;
}

function detectSupportedImageMimeType(header: Buffer): string | null {
	if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
		return "image/jpeg";
	}

	if (
		header.length >= 8 &&
		header[0] === 0x89 &&
		header[1] === 0x50 &&
		header[2] === 0x4e &&
		header[3] === 0x47 &&
		header[4] === 0x0d &&
		header[5] === 0x0a &&
		header[6] === 0x1a &&
		header[7] === 0x0a
	) {
		return "image/png";
	}

	if (
		header.length >= 6 &&
		header[0] === 0x47 &&
		header[1] === 0x49 &&
		header[2] === 0x46 &&
		header[3] === 0x38 &&
		(header[4] === 0x37 || header[4] === 0x39) &&
		header[5] === 0x61
	) {
		return "image/gif";
	}

	if (
		header.length >= 12 &&
		header[0] === 0x52 &&
		header[1] === 0x49 &&
		header[2] === 0x46 &&
		header[3] === 0x46 &&
		header[8] === 0x57 &&
		header[9] === 0x45 &&
		header[10] === 0x42 &&
		header[11] === 0x50
	) {
		return "image/webp";
	}

	return null;
}

export async function classifyReadPath(
	cwd: string,
	inputPath: string,
	options: ClassifyReadPathOptions = {},
): Promise<ReadPathClassification> {
	const resolvedPath = resolveReadPathForGate(inputPath, cwd, options);
	let handle;
	try {
		handle = await open(resolvedPath, "r");
	} catch {
		return { kind: "unknown", resolvedPath, mimeType: null };
	}

	try {
		const header = Buffer.alloc(12);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		const mimeType = detectSupportedImageMimeType(header.subarray(0, bytesRead));
		if (mimeType && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
			return { kind: "image", resolvedPath, mimeType };
		}
		return { kind: "non-image", resolvedPath, mimeType: null };
	} finally {
		await handle.close();
	}
}

export function ensureReadToolActive(toolNames: readonly string[]): string[] {
	if (toolNames.includes(READ_TOOL_NAME)) return [...toolNames];
	return [...toolNames, READ_TOOL_NAME];
}

export function buildNonImageReadApprovalMessage(
	input: ReadGateInput,
	classification: ReadPathClassification,
): string {
	const lines = [
		"DOE is requesting a non-image file read.",
		`Requested path: ${input.path}`,
	];
	if (classification.resolvedPath !== input.path) {
		lines.push(`Resolved path: ${classification.resolvedPath}`);
	}
	if (input.offset !== undefined) {
		lines.push(`Offset: ${input.offset}`);
	}
	if (input.limit !== undefined) {
		lines.push(`Limit: ${input.limit}`);
	}
	return lines.join("\n");
}

export async function evaluateReadGate(options: EvaluateReadGateOptions): Promise<ReadGateResult> {
	const classification = await classifyReadPath(options.cwd, options.input.path, options);
	if (classification.kind !== "non-image") return null;
	if (!options.hasUI || !options.select) {
		return { block: true, reason: NON_IMAGE_READ_NO_UI_REASON };
	}

	try {
		const choice = await options.select(buildNonImageReadApprovalTitle(options.input, classification), [...APPROVAL_OPTIONS]);
		if (choice === "Yes") return null;
		if (choice !== "No, with reason...") {
			return { block: true, reason: NON_IMAGE_READ_BLOCK_REASON };
		}
		if (!options.promptInput) {
			return { block: true, reason: NON_IMAGE_READ_NO_UI_REASON };
		}
		const reason = normalizeDenialReason(
			await options.promptInput("Reason for denying this read", "Optional reason"),
		);
		return {
			toolResult: buildDeniedReadToolResult(reason),
			isError: false,
		};
	} catch {
		return { block: true, reason: NON_IMAGE_READ_NO_UI_REASON };
	}
}
