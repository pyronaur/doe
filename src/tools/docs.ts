import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DocsActionSchema = StringEnum(["browse", "ls", "query", "topic", "help", "ops_help"] as const);

function stripLeadingAt(value?: string): string | undefined {
	if (typeof value !== "string") return value;
	return value.replace(/^@+/, "");
}

function truncateOutput(text: string, maxChars = 16_000, maxLines = 300): string {
	const lines = text.split("\n");
	const limitedLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
	let output = limitedLines.join("\n");
	if (output.length > maxChars) {
		output = output.slice(0, maxChars);
	}
	if (limitedLines.length < lines.length || output.length < text.length) {
		output += "\n... (truncated)";
	}
	return output;
}

function buildArgs(params: {
	action: "browse" | "ls" | "query" | "topic" | "help" | "ops_help";
	selector?: string;
	selectors?: string[];
	query?: string;
	limit?: number;
	topic?: string;
	path?: string;
}): string[] {
	switch (params.action) {
		case "browse":
			return params.selector ? [stripLeadingAt(params.selector)!] : [];
		case "ls":
			return ["ls", ...(params.selectors ?? []).map((value) => stripLeadingAt(value)!)];
		case "query": {
			const query = params.query?.trim();
			if (!query) throw new Error("docs query requires a non-empty query string.");
			return ["query", ...(params.limit ? ["--limit", String(params.limit)] : []), ...query.split(/\s+/)];
		}
		case "topic": {
			const topic = params.topic?.trim();
			if (!topic) throw new Error("docs topic requires a topic name.");
			const path = stripLeadingAt(params.path?.trim());
			return ["topic", topic, ...(path ? [path] : [])];
		}
		case "help":
			return ["--help"];
		case "ops_help":
			return ["--ops-help"];
		default:
			return [];
	}
}

export function registerDocsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "docs",
		label: "Docs CLI",
		description: "Browse or query the local docs CLI without exposing general shell access.",
		promptSnippet: "Use the docs CLI to browse parked docs roots, list local docs, or run docs query for quick documentation lookup.",
		promptGuidelines: [
			"Use docs for lightweight documentation lookup before delegating broader research to Codex.",
			"Prefer docs over general shell access when the task is specifically about local machine or project documentation.",
		],
		parameters: Type.Object({
			action: DocsActionSchema,
			selector: Type.Optional(Type.String({ description: "Single docs selector for browse mode, such as local/setup or ./docs/file.md" })),
			selectors: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "Selectors for docs ls" })),
			query: Type.Optional(Type.String({ description: "Query text for docs query" })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			topic: Type.Optional(Type.String({ description: "Topic name for docs topic" })),
			path: Type.Optional(Type.String({ description: "Optional topic subpath for docs topic" })),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `docs ${String((args as any)?.action ?? "")}`.trim()), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", "docs") + "\n" + String(result.content?.[0]?.text ?? ""), 0, 0);
		},
		async execute(_toolCallId, params, signal) {
			const args = buildArgs(params as any);
			const result = await pi.exec("docs", args, { signal, timeout: 20_000 });
			const stdout = result.stdout?.trim() ?? "";
			const stderr = result.stderr?.trim() ?? "";
			const combined = [stdout, stderr].filter(Boolean).join("\n\n");
			if (result.code !== 0) {
				throw new Error(combined || `docs exited with code ${result.code}`);
			}
			return {
				content: [{ type: "text", text: truncateOutput(combined || "(no output)") }],
				details: {
					command: "docs",
					args,
					code: result.code,
					stdout,
					stderr,
				},
			};
		},
	});
}
