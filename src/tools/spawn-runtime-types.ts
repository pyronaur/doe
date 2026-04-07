import type { SandboxMode } from "../codex/client.ts";
import type { ICRole, NotificationMode } from "../roster/types.ts";
import type { SpawnExecuteContext, SpawnToolDeps } from "./spawn.ts";

export interface SpawnExecutionInput {
	params: any;
	signal: AbortSignal | undefined;
	onUpdate: ((update: any) => void) | undefined;
	deps: SpawnToolDeps;
	resolveSandboxMode: (
		role: ICRole | null | undefined,
		sandbox?: SandboxMode | null,
	) => SandboxMode;
}

export interface SpawnBatchContext {
	batchId: string | null;
	batchName: string;
	notificationMode: NotificationMode;
	returnMode: "wait";
	agentIds: string[];
	promptsByAgentId: Record<string, string>;
}

export type SpawnExecuteArgs = [
	string,
	any,
	AbortSignal | undefined,
	((update: any) => void) | undefined,
	SpawnExecuteContext | undefined,
];
