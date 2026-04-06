import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface MarkdownDoc {
	name: string;
	path: string;
	raw: string;
	body: string;
	attributes: Record<string, unknown>;
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((part) => parseScalar(part.trim()))
			.filter((part) => part !== "");
	}
	return trimmed;
}

function parseFrontmatter(raw: string): { attributes: Record<string, unknown>; body: string } {
	if (!raw.startsWith("---\n")) {
		return { attributes: {}, body: raw };
	}

	const end = raw.indexOf("\n---\n", 4);
	if (end === -1) {
		return { attributes: {}, body: raw };
	}

	const header = raw.slice(4, end);
	const body = raw.slice(end + 5);
	const attributes: Record<string, unknown> = {};
	let activeListKey: string | null = null;

	for (const rawLine of header.split(/\r?\n/)) {
		const line = rawLine.replace(/\t/g, "  ");
		if (!line.trim()) continue;

		const listMatch = line.match(/^\s*-\s+(.*)$/);
		if (listMatch && activeListKey) {
			const existing = Array.isArray(attributes[activeListKey]) ? (attributes[activeListKey] as unknown[]) : [];
			existing.push(parseScalar(listMatch[1] ?? ""));
			attributes[activeListKey] = existing;
			continue;
		}

		activeListKey = null;
		const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
		if (!match) continue;

		const key = match[1] as string;
		const value = match[2] ?? "";
		if (!value.trim()) {
			attributes[key] = [];
			activeListKey = key;
			continue;
		}
		attributes[key] = parseScalar(value);
	}

	return { attributes, body };
}

export function loadMarkdownDoc(path: string): MarkdownDoc | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf-8");
	const { attributes, body } = parseFrontmatter(raw);
	return {
		name: basename(path).replace(/\.md$/i, ""),
		path,
		raw,
		body: body.trim(),
		attributes,
	};
}

export function loadMarkdownDocs(dir: string): MarkdownDoc[] {
	if (!existsSync(dir)) return [];
	const docs: MarkdownDoc[] = [];
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		if (!entry.toLowerCase().endsWith(".md")) continue;
		if (!statSync(fullPath).isFile()) continue;
		const doc = loadMarkdownDoc(fullPath);
		if (doc) docs.push(doc);
	}
	return docs.sort((a, b) => a.name.localeCompare(b.name));
}

export function renderMarkdownTemplate(doc: MarkdownDoc, variables: Record<string, unknown>): string {
	return doc.body.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
		const value = variables[key];
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		return JSON.stringify(value, null, 2);
	});
}

export function summarizeTemplates(docs: MarkdownDoc[]): string {
	if (docs.length === 0) return "No templates are installed.";
	return docs
		.map((doc) => {
			const purpose = typeof doc.attributes.purpose === "string" ? doc.attributes.purpose : "general delegation";
			const whenToUse = Array.isArray(doc.attributes.when_to_use)
				? (doc.attributes.when_to_use as unknown[]).join("; ")
				: typeof doc.attributes.when_to_use === "string"
					? doc.attributes.when_to_use
					: "no extra guidance";
			const model = typeof doc.attributes.default_model === "string" ? doc.attributes.default_model : "inherit";
			const effort = typeof doc.attributes.default_effort === "string" ? doc.attributes.default_effort : "inherit";
			return `- ${doc.name}: purpose=${purpose}; default_model=${model}; default_effort=${effort}; when_to_use=${whenToUse}`;
		})
		.join("\n");
}
