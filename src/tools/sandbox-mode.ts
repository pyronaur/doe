import type { SandboxMode } from "../codex/client.ts";
import type { ICRole } from "../roster/types.ts";

export function resolveSandboxMode(
	role: ICRole | null | undefined,
	sandbox?: SandboxMode | null,
): SandboxMode {
	if (role === "researcher" || role === "senior") {
		return "danger-full-access";
	}
	if (role === "mid") {
		return sandbox === "danger-full-access"
			? "danger-full-access"
			: "workspace-write";
	}
	return "read-only";
}
