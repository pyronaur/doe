import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ensureSessionWorkspace, prepareSessionWorkspace } from "../plan/slug.js";

function formatReuseError(result: ReturnType<typeof prepareSessionWorkspace>): string {
	const lines = result.existingEntries.map((entry) => `- ${entry}`);
	return [
		`Session workspace already exists and is not empty: ${result.workspacePath}`,
		"Existing entries:",
		...(lines.length > 0 ? lines : ["- (empty)"]),
		"",
		"Retry only if this existing workspace should be reused by calling session_set again with allowExisting=true.",
	].join("\n");
}

export function registerSessionSetTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_set",
		label: "Session Set",
		description: "Set the canonical DoE session slug and shared workspace directory.",
		promptSnippet: "Set the DoE session slug.",
		promptGuidelines: ["Pass one sessionSlug for the current DoE session."],
		parameters: Type.Object({
			sessionSlug: Type.String(),
			allowExisting: Type.Optional(Type.Boolean()),
		}),
		renderCall(args, theme) {
			return new Text(theme.fg("accent", `session_set ${(args as any).sessionSlug ?? ""}`.trim()), 0, 0);
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", result.content?.[0]?.text ?? "session_set"), 0, 0);
		},
		async execute(_toolCallId, params) {
			const result = prepareSessionWorkspace({
				repoRoot: process.cwd(),
				sessionSlug: params.sessionSlug,
				allowExisting: params.allowExisting,
			});
			if (result.requiresAllowExisting) {
				throw new Error(formatReuseError(result));
			}

			ensureSessionWorkspace(result.workspacePath);
			pi.setSessionName(result.sessionSlug);

			const content = [
				`session_slug: ${result.sessionSlug}`,
				`workspace: ${result.workspacePath}`,
				result.requestedSlug === result.sessionSlug ? null : `normalized_from: ${result.requestedSlug}`,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: content }],
				details: {
					sessionSlug: result.sessionSlug,
					workspacePath: result.workspacePath,
					normalizedFrom: result.requestedSlug === result.sessionSlug ? null : result.requestedSlug,
				},
			};
		},
	});
}
