import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface DirectoryInspection {
	path: string;
	exists: boolean;
	entries: string[];
}

export interface PreparedSessionWorkspace {
	requestedSlug: string;
	sessionSlug: string;
	workspaceRoot: string;
	workspacePath: string;
	existingEntries: string[];
	requiresAllowExisting: boolean;
}

function normalizeSlugPart(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function normalizeRequestedSlug(value: string, label: string): string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a string.`);
	}
	const slug = normalizeSlugPart(value.trim());
	if (!slug) {
		throw new Error(`${label} must contain at least one letter or number.`);
	}
	return slug;
}

export function normalizeSessionSlug(value: string): string {
	return normalizeRequestedSlug(value, "sessionSlug");
}

export function normalizePlanSlug(value: string): string {
	return normalizeRequestedSlug(value, "planSlug");
}

export function getSessionWorkspaceRoot(repoRoot: string): string {
	return resolve(repoRoot, ".tmp");
}

export function getSessionWorkspacePath(repoRoot: string, sessionSlug: string): string {
	return resolve(getSessionWorkspaceRoot(repoRoot), normalizeSessionSlug(sessionSlug));
}

export function getPlanFilePath(repoRoot: string, sessionSlug: string, planSlug: string): string {
	return resolve(getSessionWorkspacePath(repoRoot, sessionSlug),
		`plan-${normalizePlanSlug(planSlug)}.md`);
}

export function inspectDirectory(path: string): DirectoryInspection {
	if (!existsSync(path)) {
		return {
			path,
			exists: false,
			entries: [],
		};
	}
	const stats = statSync(path);
	if (!stats.isDirectory()) {
		throw new Error(`Expected a directory at ${path}, but found a non-directory entry.`);
	}
	return {
		path,
		exists: true,
		entries: readdirSync(path).sort((a, b) => a.localeCompare(b)),
	};
}

export function prepareSessionWorkspace(input: {
	repoRoot: string;
	sessionSlug: string;
	allowExisting?: boolean;
}): PreparedSessionWorkspace {
	const sessionSlug = normalizeSessionSlug(input.sessionSlug);
	const workspaceRoot = getSessionWorkspaceRoot(input.repoRoot);
	const workspacePath = getSessionWorkspacePath(input.repoRoot, sessionSlug);
	const inspection = inspectDirectory(workspacePath);
	const existingEntries = inspection.entries;
	const requiresAllowExisting = existingEntries.length > 0 && input.allowExisting !== true;
	return {
		requestedSlug: input.sessionSlug,
		sessionSlug,
		workspaceRoot,
		workspacePath,
		existingEntries,
		requiresAllowExisting,
	};
}

export function ensureSessionWorkspace(path: string): void {
	mkdirSync(path, { recursive: true });
}
