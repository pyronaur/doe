import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const SharedSpawnSeatFields = {
	name: Type.Optional(Type.String()),
	ic: Type.Optional(Type.String()),
	role: Type.Optional(StringEnum(["researcher", "senior", "mid", "junior", "intern"] as const)),
	cwd: Type.Optional(Type.String()),
};

export const AgentLookupFields = {
	ic: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
};

export const EffortSchema = StringEnum(["low", "medium", "high", "xhigh"] as const);
export const ApprovalSchema = StringEnum(
	["never", "on-request", "on-failure", "untrusted"] as const,
);
export const SandboxSchema = StringEnum(
	["read-only", "workspace-write", "danger-full-access"] as const,
);
export const RoleSchema = StringEnum(["researcher", "senior", "mid", "junior", "intern"] as const);
export const SharedExecutionOptionFields = {
	model: Type.Optional(Type.String()),
	effort: Type.Optional(EffortSchema),
	template: Type.Optional(Type.String()),
	templateVariables: Type.Optional(Type.Record(Type.String(), Type.Any())),
	approvalPolicy: Type.Optional(ApprovalSchema),
	networkAccess: Type.Optional(Type.Boolean()),
	allowWrite: Type.Optional(Type.Boolean()),
	sandbox: Type.Optional(SandboxSchema),
};
export const SpawnTaskFields = {
	...SharedSpawnSeatFields,
	prompt: Type.String(),
	...SharedExecutionOptionFields,
};
export const SpawnParametersFields = {
	...SharedSpawnSeatFields,
	prompt: Type.Optional(Type.String()),
	...SharedExecutionOptionFields,
};
