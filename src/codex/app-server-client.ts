import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { CurrentContextUsage } from "../context-usage.ts";
import { isRecord } from "../utils/guards.ts";
import {
	handleAppServerNotification,
	normalizeCurrentContextUsage,
	normalizeThreadTokenUsage,
} from "./app-server-support.ts";
import {
	buildDangerFullAccessSandbox,
	buildReadOnlySandbox,
	type CodexClientEvent,
	type SandboxMode,
	type ThreadStartOptions,
	type ThreadSummary,
	type TurnStartOptions,
	type TurnSteerOptions,
} from "./client.ts";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

export type PermissionGrantScope = "turn" | "session";

export interface PermissionProfile {
	fileSystem?: {
		read?: string[] | null;
		write?: string[] | null;
	} | null;
	network?: {
		enabled?: boolean | null;
	} | null;
}

export interface PermissionApprovalRequest {
	threadId: string;
	turnId: string;
	itemId: string;
	reason: string | null;
	permissions: PermissionProfile;
}

export interface PermissionApprovalResult {
	approved: boolean;
	permissions?: PermissionProfile;
	scope?: PermissionGrantScope;
}

function normalizeScope(value: unknown): PermissionGrantScope {
	return value === "session" ? "session" : "turn";
}

function normalizePathList(value: unknown): string[] | null | undefined {
	if (value === null) {
		return null;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizePermissionProfile(value: unknown): PermissionProfile {
	if (!isRecord(value)) {
		return {};
	}
	const profile: PermissionProfile = {};
	const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : null;
	const network = isRecord(value.network) ? value.network : null;
	if (fileSystem || value.fileSystem === null) {
		if (!fileSystem) {
			profile.fileSystem = null;
		}
		if (fileSystem) {
			profile.fileSystem = {};
			const read = normalizePathList(fileSystem.read);
			const write = normalizePathList(fileSystem.write);
			if (read !== undefined) {
				profile.fileSystem.read = read;
			}
			if (write !== undefined) {
				profile.fileSystem.write = write;
			}
		}
	}
	if (network || value.network === null) {
		if (!network) {
			profile.network = null;
		}
		if (network) {
			const enabled = typeof network.enabled === "boolean" || network.enabled === null
				? network.enabled
				: undefined;
			profile.network = enabled === undefined ? {} : { enabled };
		}
	}
	return profile;
}

function buildSandboxPolicy(sandbox: SandboxMode, networkAccess = false) {
	if (sandbox === "read-only") { return buildReadOnlySandbox(networkAccess); }
	if (sandbox === "workspace-write") {
		return {
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		} as const;
	}
	return buildDangerFullAccessSandbox();
}

function parseContextUsage(value: unknown): CurrentContextUsage | null {
	const usage = normalizeCurrentContextUsage(value);
	if (usage) {
		return usage;
	}
	const tokenUsage = normalizeThreadTokenUsage(value);
	if (!tokenUsage) {
		return null;
	}
	return normalizeCurrentContextUsage({
		last_token_usage: { total_tokens: tokenUsage.last.totalTokens },
		total_token_usage: { total_tokens: tokenUsage.total.totalTokens },
		model_context_window: tokenUsage.modelContextWindow,
	});
}

export class CodexAppServerClient extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private reader: readline.Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private starting: Promise<void> | null = null;
	private readonly threadWriteAccess = new Map<string, boolean>();
	private readonly options: {
		command?: string;
		serviceName?: string;
		requestPermissionApproval?: (
			request: PermissionApprovalRequest,
		) => Promise<PermissionApprovalResult> | PermissionApprovalResult;
	};

	constructor(
		options: {
			command?: string;
			serviceName?: string;
			requestPermissionApproval?: (
				request: PermissionApprovalRequest,
			) => Promise<PermissionApprovalResult> | PermissionApprovalResult;
		} = {},
	) {
		super();
		this.options = options;
	}

	async ensureStarted(): Promise<void> {
		if (this.proc) { return; }
		if (this.starting) {
			await this.starting;
			return;
		}

		this.starting = (async () => {
			const command = this.options.command ?? "codex";
			this.proc = spawn(command, ["app-server"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
			this.proc.stderr.on("data", (data) => {
				const text = String(data).trim();
				if (text) { console.error(`[doe/codex] ${text}`); }
			});
			this.proc.on("exit", (code, signal) => {
				const reason = `Codex app-server exited (code=${code ?? "null"}, signal=${
					signal ?? "null"
				})`;
				this.failPending(reason);
				this.proc = null;
				this.reader?.close();
				this.reader = null;
				this.threadWriteAccess.clear();
				this.emit("event", { type: "error", message: reason } satisfies CodexClientEvent);
			});
			this.reader = readline.createInterface({ input: this.proc.stdout });
			this.reader.on("line", (line) => this.handleLine(line));

			await this.requestRaw("initialize", {
				clientInfo: {
					name: "pi_doe",
					title: "Pi Director of Engineering",
					version: "0.1.0",
				},
				capabilities: {
					experimentalApi: true,
				},
			});
			this.send({ method: "initialized", params: {} });
		})();

		try {
			await this.starting;
		} finally {
			this.starting = null;
		}
	}

	async startThread(options: ThreadStartOptions): Promise<any> {
		await this.ensureStarted();
		const allowWrite = options.allowWrite ?? false;
		const result = await this.request("thread/start", {
			model: options.model,
			cwd: options.cwd,
			approvalPolicy: options.approvalPolicy ?? "never",
			sandbox: options.sandbox ?? "danger-full-access",
			serviceName: options.serviceName ?? this.options.serviceName ?? "pi_doe",
			baseInstructions: options.baseInstructions ?? null,
			developerInstructions: options.developerInstructions ?? null,
			ephemeral: options.ephemeral ?? false,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
		});
		if (result?.thread?.id) {
			this.threadWriteAccess.set(result.thread.id, allowWrite);
		}
		return result;
	}

	async resumeThread(
		options: {
			threadId: string;
			model?: string;
			cwd?: string;
			approvalPolicy?: string;
			allowWrite?: boolean;
			sandbox?: SandboxMode;
		},
	): Promise<any> {
		await this.ensureStarted();
		const allowWrite = options.allowWrite ?? this.threadWriteAccess.get(options.threadId) ?? false;
		const result = await this.request("thread/resume", {
			threadId: options.threadId,
			model: options.model ?? null,
			cwd: options.cwd ?? null,
			approvalPolicy: options.approvalPolicy ?? "never",
			sandbox: options.sandbox ?? "danger-full-access",
			persistExtendedHistory: true,
		});
		this.threadWriteAccess.set(options.threadId, allowWrite);
		return result;
	}

	async listThreads(
		params: { limit?: number; cursor?: string | null; cwd?: string; archived?: boolean } = {},
	): Promise<any> {
		await this.ensureStarted();
		return this.request("thread/list", {
			limit: params.limit ?? 20,
			cursor: params.cursor ?? null,
			cwd: params.cwd ?? null,
			archived: params.archived ?? false,
			sortKey: "updated_at",
			sourceKinds: ["appServer", "vscode", "cli", "unknown"],
		});
	}

	async readThread(threadId: string, includeTurns = true): Promise<{ thread: ThreadSummary }> {
		await this.ensureStarted();
		return this.request("thread/read", { threadId, includeTurns });
	}

	async readContextWindowUsage(
		threadId: string,
		turnId?: string | null,
	): Promise<CurrentContextUsage | null> {
		await this.ensureStarted();
		const result = await this.request("thread/read", {
			threadId,
			includeTurns: false,
		});
		const candidates = [
			result?.usage,
			result?.tokenUsage,
			result?.thread?.usage,
			result?.thread?.tokenUsage,
			result,
		];
		for (const candidate of candidates) {
			const usage = parseContextUsage(candidate);
			if (usage) {
				return usage;
			}
		}
		return null;
	}

	async startTurn(options: TurnStartOptions): Promise<any> {
		await this.ensureStarted();
		const allowWrite = options.allowWrite ?? this.threadWriteAccess.get(options.threadId) ?? false;
		this.threadWriteAccess.set(options.threadId, allowWrite);
		return this.request("turn/start", {
			threadId: options.threadId,
			input: [{ type: "text", text: options.prompt }],
			cwd: options.cwd,
			approvalPolicy: options.approvalPolicy ?? "never",
			sandboxPolicy: buildSandboxPolicy(options.sandbox ?? "danger-full-access",
				options.networkAccess ?? false),
			model: options.model,
			effort: options.effort ?? "medium",
		});
	}

	async steerTurn(options: TurnSteerOptions): Promise<any> {
		await this.ensureStarted();
		return this.request("turn/steer", {
			threadId: options.threadId,
			input: [{ type: "text", text: options.prompt }],
			expectedTurnId: options.expectedTurnId,
		});
	}

	async interruptTurn(threadId: string, turnId: string): Promise<any> {
		await this.ensureStarted();
		return this.request("turn/interrupt", { threadId, turnId });
	}

	async unsubscribeThread(threadId: string): Promise<any> {
		await this.ensureStarted();
		this.threadWriteAccess.delete(threadId);
		return this.request("thread/unsubscribe", { threadId });
	}

	close(): void {
		this.reader?.close();
		this.reader = null;
		this.threadWriteAccess.clear();
		if (this.proc) {
			const proc = this.proc;
			this.proc = null;
			if (proc.stdin.writable) {
				proc.stdin.end();
			}
			proc.kill();
		}
	}

	private send(message: Record<string, unknown>) {
		if (!this.proc?.stdin.writable) { throw new Error("Codex app-server stdin is not writable"); }
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private async request(method: string, params: unknown): Promise<any> {
		await this.ensureStarted();
		return this.requestRaw(method, params);
	}

	private async requestRaw(method: string, params: unknown): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ method, id, params });
		});
	}

	private handleLine(line: string) {
		const message = this.parseLine(line);
		if (!message) { return; }
		const requestId = typeof message.id === "number" ? message.id : null;
		const method = typeof message.method === "string" ? message.method : null;
		const params = isRecord(message.params) ? message.params : {};

		if (requestId !== null && method) {
			void this.handleServerRequest(requestId, method, params);
			return;
		}
		if (requestId !== null) {
			this.handleResponse(requestId, message);
			return;
		}
		if (method) { this.handleNotification(method, params); }
	}

	private parseLine(line: string): Record<string, unknown> | null {
		if (!line.trim()) { return null; }
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			console.error("[doe/codex] Failed to parse JSON line:", line, error);
			return null;
		}
		if (!isRecord(message)) {
			console.error("[doe/codex] Parsed non-object JSON line:", line);
			return null;
		}
		return message;
	}

	private handleResponse(requestId: number, message: Record<string, unknown>) {
		const pending = this.pending.get(requestId);
		if (!pending) { return; }
		this.pending.delete(requestId);
		if (isRecord(message.error)) {
			const errorMessage = typeof message.error.message === "string"
				? message.error.message
				: `Request failed: ${JSON.stringify(message.error)}`;
			pending.reject(new Error(errorMessage));
			return;
		}
		pending.resolve(message.result);
	}

	private async handleServerRequest(
		id: number,
		method: string,
		params: Record<string, unknown>,
	) {
		const respond = (result: unknown) => this.send({ id, result });
		const respondError = (code: number, errorMessage: string) =>
			this.send({ id, error: { code, message: errorMessage } });
		const threadId = typeof params.threadId === "string" ? params.threadId : null;
		const allowWrite = threadId ? this.threadWriteAccess.get(threadId) ?? false : false;

		if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
			respond({ decision: allowWrite ? "accept" : "decline" });
			return;
		}
		if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
			respond({ decision: allowWrite ? "accept" : "decline" });
			return;
		}
		if (method === "item/permissions/requestApproval") {
			respond(await this.handlePermissionApprovalRequest(params));
			return;
		}
		if (method === "item/tool/requestUserInput") {
			respond({ answers: {} });
			return;
		}
		if (method === "item/tool/call") {
			respond({ contentItems: [], success: false });
			return;
		}
		respondError(-32601, `Unsupported server request: ${method}`);
	}

	private async handlePermissionApprovalRequest(
		params: Record<string, unknown>,
	): Promise<{ permissions: PermissionProfile; scope: PermissionGrantScope }> {
		const fallbackScope: PermissionGrantScope = "turn";
		const request: PermissionApprovalRequest = {
			threadId: typeof params.threadId === "string" ? params.threadId : "",
			turnId: typeof params.turnId === "string" ? params.turnId : "",
			itemId: typeof params.itemId === "string" ? params.itemId : "",
			reason: typeof params.reason === "string" ? params.reason : null,
			permissions: normalizePermissionProfile(params.permissions),
		};
		if (!request.threadId || !request.turnId || !request.itemId) {
			return { permissions: {}, scope: fallbackScope };
		}
		const onRequestApproval = this.options.requestPermissionApproval;
		if (!onRequestApproval) {
			return { permissions: {}, scope: fallbackScope };
		}
		try {
			const decision = await onRequestApproval(request);
			const scope = normalizeScope(decision.scope ?? fallbackScope);
			if (!decision.approved) {
				return { permissions: {}, scope };
			}
			return {
				permissions: normalizePermissionProfile(decision.permissions ?? request.permissions),
				scope,
			};
		} catch (error) {
			console.error("[doe/codex] Permissions approval request failed", error);
			return { permissions: {}, scope: fallbackScope };
		}
	}

	private handleNotification(method: string, params: Record<string, unknown>) {
		handleAppServerNotification(method, params, {
			emit: (event) => this.emit("event", event),
			threadWriteAccess: this.threadWriteAccess,
		});
	}

	private failPending(message: string) {
		for (const pending of this.pending.values()) {
			pending.reject(new Error(message));
		}
		this.pending.clear();
	}
}
