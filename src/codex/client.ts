export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export interface ThreadSummary {
	id: string;
	name?: string | null;
	preview?: string;
	cwd?: string;
	status?: { type?: string; activeFlags?: string[] } | null;
	turns?: Array<{
		id: string;
		status: string;
		error?: { message?: string | null } | null;
		items?: Array<any>;
	}>;
}

export interface ThreadStartOptions {
	model: string;
	cwd: string;
	approvalPolicy?: ApprovalPolicy;
	networkAccess?: boolean;
	serviceName?: string;
	baseInstructions?: string;
	developerInstructions?: string;
	ephemeral?: boolean;
	allowWrite?: boolean;
}

export interface TurnStartOptions {
	threadId: string;
	prompt: string;
	cwd: string;
	model: string;
	effort?: ReasoningEffort;
	approvalPolicy?: ApprovalPolicy;
	networkAccess?: boolean;
	allowWrite?: boolean;
}

export interface TurnSteerOptions {
	threadId: string;
	expectedTurnId: string;
	prompt: string;
	allowWrite?: boolean;
}

export type CodexClientEvent =
	| { type: "thread-started"; thread: ThreadSummary }
	| { type: "thread-status"; threadId: string; status: { type?: string; activeFlags?: string[] } }
	| { type: "turn-started"; threadId: string; turnId: string }
	| { type: "turn-completed"; threadId: string; turnId: string; status: string; error?: string | null }
	| { type: "agent-message-delta"; threadId: string; turnId: string; itemId: string; delta: string }
	| { type: "agent-message-complete"; threadId: string; turnId: string; itemId: string; text: string }
	| { type: "error"; threadId?: string; message: string };

export function buildReadOnlySandbox(networkAccess = false) {
	return {
		type: "readOnly",
		access: { type: "fullAccess" },
		networkAccess,
	} as const;
}

export function buildWorkspaceWriteSandbox(cwd: string, networkAccess = false) {
	return {
		type: "workspaceWrite",
		writableRoots: [cwd],
		readOnlyAccess: { type: "fullAccess" },
		networkAccess,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false,
	} as const;
}

export function extractTurnMessages(thread: ThreadSummary | null | undefined): {
	firstUserMessage: string | null;
	lastAgentMessage: string | null;
} {
	let firstUserMessage: string | null = null;
	let lastAgentMessage: string | null = null;

	for (const turn of thread?.turns ?? []) {
		for (const item of turn.items ?? []) {
			if (item?.type === "userMessage" && firstUserMessage === null) {
				const text = (item.content ?? [])
					.filter((part: any) => part?.type === "text")
					.map((part: any) => part.text)
					.join("\n")
					.trim();
				if (text) firstUserMessage = text;
			}
			if (item?.type === "agentMessage") {
				const text = typeof item.text === "string" ? item.text.trim() : "";
				if (text) lastAgentMessage = text;
			}
		}
	}

	return { firstUserMessage, lastAgentMessage };
}

export function truncateForDisplay(text: string | null | undefined, max = 220): string {
	if (!text) return "";
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max - 1)}…`;
}
