import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import type { SandboxMode } from "../codex/client.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { readToolProgressSummary } from "./progress-updates.ts";
import { resolveSpawnRenderBody } from "./spawn-result.ts";
import { createSpawnExecuteHandler, normalizeMultiTaskArgs } from "./spawn-runtime.ts";

const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
const ApprovalSchema = StringEnum(["never", "on-request", "on-failure", "untrusted"] as const);
const SandboxSchema = StringEnum(["read-only", "workspace-write", "danger-full-access"] as const);
const RoleSchema = StringEnum(["researcher", "senior", "mid", "junior", "intern"] as const);

const TaskSchema = Type.Object({
	name: Type.Optional(Type.String()),
	ic: Type.Optional(Type.String()),
	role: Type.Optional(RoleSchema),
	prompt: Type.String(),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
	sandbox: Type.Optional(SandboxSchema),
});

const SpawnParametersSchema = Type.Object({
	tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 8 })),
	name: Type.Optional(Type.String()),
	ic: Type.Optional(Type.String()),
	role: Type.Optional(RoleSchema),
	prompt: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
	sandbox: Type.Optional(SandboxSchema),
	batchName: Type.Optional(Type.String()),
});

export interface SpawnToolDeps {
	client: CodexAppServerClient;
	registry: DoeRegistry;
	templatesDir: string;
	getSessionSlug?: () => string | null;
	setWorkingMessage?: (summary?: string) => void;
}

export interface SpawnExecuteContext {
	hasUI?: boolean;
	ui?: {
		setWorkingMessage(summary?: string): void;
	};
}

function createSpawnTool(
	input: {
		name: "codex_spawn" | "codex_delegate";
		label: string;
		description: string;
		promptSnippet: string;
		promptGuidelines: string[];
		renderCallLabel: (args: any) => string;
	},
	deps: SpawnToolDeps,
) {
	const execute = createSpawnExecuteHandler({
		deps,
		resolveSandboxMode,
	});
	return {
		name: input.name,
		label: input.label,
		description: input.description,
		promptSnippet: input.promptSnippet,
		promptGuidelines: input.promptGuidelines,
		parameters: SpawnParametersSchema,
		prepareArguments: normalizeMultiTaskArgs,
		renderCall(args: any, theme: any) {
			return new Text(theme.fg("accent", input.renderCallLabel(args)), 0, 0);
		},
		renderResult(result: any, options: any, _theme: any) {
			if (options.isPartial && readToolProgressSummary(result)) {
				return new Container();
			}
			return new Text(resolveSpawnRenderBody(result), 0, 0);
		},
		execute,
	};
}

export function resolveSandboxMode(
	role: "researcher" | "senior" | "mid" | "junior" | "intern" | null | undefined,
	sandbox?: SandboxMode | null,
): SandboxMode {
	if (role === "researcher" || role === "senior") {
		return "danger-full-access";
	}
	if (role === "mid") {
		return sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write";
	}
	return "read-only";
}

export function registerSpawnTool(pi: ExtensionAPI, deps: SpawnToolDeps) {
	pi.registerTool(
		createSpawnTool(
			{
				name: "codex_spawn",
				label: "Codex Spawn",
				description: "Spawn one or more named IC assignments. Each task gets its own thread and seat.",
				promptSnippet:
					"Spawn new Codex workers for scanning, research, planning, or implementation. Use tasks[] for parallel independent work.",
				promptGuidelines: [
					"Use for new work only. Do not use when an existing thread has relevant context — use codex_resume instead.",
					"Use name for the task label. Use ic for seat targeting.",
					"Fresh spawn on the same seat starts a new thread and does not preserve thread memory. Use codex_resume when the same thread context should continue.",
					"Pass ic to target a specific named seat, or pass role to auto-allocate the next free IC in researcher|senior|mid|junior|intern. DOE rejects tasks that omit both.",
					"Compatibility shim: if name exactly matches an existing seat and ic is omitted, DOE treats that name as the intended seat.",
					"Each new task gets a fresh assignment. If a role is full, DOE allocates contractor-N overflow seats.",
					"Specify model and reasoning separately: use model like gpt-5.4 and effort like low|medium|high|xhigh. Do not pass combined strings like gpt-5.4-high.",
					"Sandbox follows DOE role policy. `allowWrite` only controls auto-approval of file-change requests; use `sandbox=\"danger-full-access\"` for mid-level workers when you need full access.",
					"Waits for workers to complete and returns each worker's full final answer in content. Use that returned content directly as the worker result.",
				],
				renderCallLabel(args) {
					const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 1;
					return `codex_spawn ${taskCount > 1 ? `${taskCount} agents` : "1 agent"}`;
				},
			},
			deps,
		),
	);

	pi.registerTool(
		createSpawnTool(
			{
				name: "codex_delegate",
				label: "Codex Delegate",
				description: "Alias for codex_spawn.",
				promptSnippet: "Alias of codex_spawn — identical behavior.",
				promptGuidelines: ["Use codex_spawn instead. Both tools are identical."],
				renderCallLabel(args) {
					return `codex_delegate ${args.batchName ?? "task"}`;
				},
			},
			deps,
		),
	);
}
