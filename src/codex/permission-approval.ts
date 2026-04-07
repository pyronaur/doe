import type {
	PermissionApprovalRequest,
	PermissionApprovalResult,
} from "./app-server-client.ts";

interface PermissionApprovalRuntime {
	latestCtx: {
		hasUI: boolean;
		ui: {
			select: (title: string, options: string[]) => Promise<string | undefined>;
		};
	} | null;
	registry: {
		getAgentByThreadId: (
			threadId: string,
		) => { id: string; seatName?: string | null; name?: string | null } | undefined;
	};
}

function formatIdentity(runtime: PermissionApprovalRuntime, threadId: string): string {
	const agent = runtime.registry.getAgentByThreadId(threadId);
	if (!agent) {
		return threadId || "unknown";
	}
	return `${agent.seatName ?? agent.name ?? "unknown"} (${agent.id})`;
}

function formatPermissionLines(request: PermissionApprovalRequest): string[] {
	const lines: string[] = [];
	const readPaths = request.permissions.fileSystem?.read;
	if (readPaths === null || (Array.isArray(readPaths) && readPaths.length > 0)) {
		lines.push(`filesystem read: ${readPaths === null ? "none" : readPaths.join(", ")}`);
	}
	const writePaths = request.permissions.fileSystem?.write;
	if (writePaths === null || (Array.isArray(writePaths) && writePaths.length > 0)) {
		lines.push(`filesystem write: ${writePaths === null ? "none" : writePaths.join(", ")}`);
	}
	if (typeof request.permissions.network?.enabled === "boolean") {
		lines.push(`network: ${request.permissions.network.enabled ? "enabled" : "disabled"}`);
	}
	return lines.length > 0 ? lines : ["(no additional permissions requested)"];
}

export async function requestDirectorPermissionApproval(
	runtime: PermissionApprovalRuntime,
	request: PermissionApprovalRequest,
): Promise<PermissionApprovalResult> {
	const ctx = runtime.latestCtx;
	if (!ctx?.hasUI) {
		return { approved: false };
	}
	const titleLines = [
		"IC permission approval required.",
		`IC: ${formatIdentity(runtime, request.threadId)}`,
		`Thread: ${request.threadId}`,
		...formatPermissionLines(request),
		...(request.reason ? [`Reason: ${request.reason}`] : []),
		"",
		"Approve this permission grant?",
	];
	const choice = await ctx.ui.select(titleLines.join("\n"), ["Yes", "No"]);
	if (choice !== "Yes") {
		return { approved: false };
	}
	return {
		approved: true,
		permissions: request.permissions,
	};
}
