import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
	buildReadOnlySandbox,
	buildWorkspaceWriteSandbox,
	type CodexClientEvent,
	type ThreadStartOptions,
	type ThreadSummary,
	type TurnStartOptions,
	type TurnSteerOptions,
} from "./client.js";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

export class CodexAppServerClient extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private reader: readline.Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private starting: Promise<void> | null = null;
	private readonly threadWriteAccess = new Map<string, boolean>();

	constructor(private readonly options: { command?: string; serviceName?: string } = {}) {
		super();
	}

	async ensureStarted(): Promise<void> {
		if (this.proc) return;
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
				if (text) console.error(`[sysop/codex] ${text}`);
			});
			this.proc.on("exit", (code, signal) => {
				const reason = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
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
					name: "pi_sysop",
					title: "Pi Sysop",
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
			sandbox: allowWrite ? "workspace-write" : "read-only",
			serviceName: options.serviceName ?? this.options.serviceName ?? "pi_sysop",
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

	async resumeThread(options: { threadId: string; model?: string; cwd?: string; approvalPolicy?: string; allowWrite?: boolean }): Promise<any> {
		await this.ensureStarted();
		const allowWrite = options.allowWrite ?? this.threadWriteAccess.get(options.threadId) ?? false;
		const result = await this.request("thread/resume", {
			threadId: options.threadId,
			model: options.model ?? null,
			cwd: options.cwd ?? null,
			approvalPolicy: options.approvalPolicy ?? "never",
			sandbox: allowWrite ? "workspace-write" : "read-only",
			persistExtendedHistory: true,
		});
		this.threadWriteAccess.set(options.threadId, allowWrite);
		return result;
	}

	async listThreads(params: { limit?: number; cursor?: string | null; cwd?: string; archived?: boolean } = {}): Promise<any> {
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

	async startTurn(options: TurnStartOptions): Promise<any> {
		await this.ensureStarted();
		const allowWrite = options.allowWrite ?? this.threadWriteAccess.get(options.threadId) ?? false;
		this.threadWriteAccess.set(options.threadId, allowWrite);
		return this.request("turn/start", {
			threadId: options.threadId,
			input: [{ type: "text", text: options.prompt }],
			cwd: options.cwd,
			approvalPolicy: options.approvalPolicy ?? "never",
			sandboxPolicy: allowWrite
				? buildWorkspaceWriteSandbox(options.cwd, options.networkAccess ?? false)
				: buildReadOnlySandbox(options.networkAccess ?? false),
			model: options.model,
			effort: options.effort ?? "medium",
			summary: "concise",
		});
	}

	async steerTurn(options: TurnSteerOptions): Promise<any> {
		await this.ensureStarted();
		if (options.allowWrite !== undefined) {
			this.threadWriteAccess.set(options.threadId, options.allowWrite);
		}
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
			try {
				proc.stdin.end();
			} catch {}
			try {
				proc.kill();
			} catch {}
		}
	}

	private send(message: Record<string, unknown>) {
		if (!this.proc?.stdin.writable) throw new Error("Codex app-server stdin is not writable");
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
		if (!line.trim()) return;
		let message: any;
		try {
			message = JSON.parse(line);
		} catch (error) {
			console.error(`[sysop/codex] Failed to parse JSON line: ${line}`);
			return;
		}

		if (message.id !== undefined && message.method) {
			void this.handleServerRequest(message);
			return;
		}

		if (message.id !== undefined) {
			const pending = this.pending.get(message.id as number);
			if (!pending) return;
			this.pending.delete(message.id as number);
			if (message.error) {
				pending.reject(new Error(message.error?.message ?? `Request failed: ${JSON.stringify(message.error)}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (typeof message.method === "string") {
			this.handleNotification(message.method, message.params ?? {});
		}
	}

	private async handleServerRequest(message: any) {
		const respond = (result: unknown) => this.send({ id: message.id, result });
		const respondError = (code: number, errorMessage: string) =>
			this.send({ id: message.id, error: { code, message: errorMessage } });
		const allowWrite = this.threadWriteAccess.get(message.params?.threadId) ?? false;

		switch (message.method) {
			case "item/commandExecution/requestApproval":
			case "execCommandApproval":
				respond({ decision: allowWrite ? "accept" : "decline" });
				return;
			case "item/fileChange/requestApproval":
			case "applyPatchApproval":
				respond({ decision: allowWrite ? "accept" : "decline" });
				return;
			case "item/permissions/requestApproval":
				respond({ permissions: {}, scope: "session" });
				return;
			case "item/tool/requestUserInput":
				respond({ answers: {} });
				return;
			case "item/tool/call":
				respond({ contentItems: [], success: false });
				return;
			default:
				respondError(-32601, `Unsupported server request: ${message.method}`);
		}
	}

	private handleNotification(method: string, params: any) {
		switch (method) {
			case "thread/started":
				if (params.thread?.id && !this.threadWriteAccess.has(params.thread.id)) {
					this.threadWriteAccess.set(params.thread.id, params.thread?.sandbox?.type === "workspaceWrite");
				}
				this.emit("event", { type: "thread-started", thread: params.thread } satisfies CodexClientEvent);
				return;
			case "thread/status/changed":
				this.emit("event", {
					type: "thread-status",
					threadId: params.threadId,
					status: params.status,
				} satisfies CodexClientEvent);
				return;
			case "turn/started":
				this.emit("event", {
					type: "turn-started",
					threadId: params.threadId,
					turnId: params.turn?.id,
				} satisfies CodexClientEvent);
				return;
			case "turn/completed":
				this.emit("event", {
					type: "turn-completed",
					threadId: params.threadId,
					turnId: params.turn?.id,
					status: params.turn?.status,
					error: params.turn?.error?.message ?? null,
				} satisfies CodexClientEvent);
				return;
			case "item/agentMessage/delta":
				this.emit("event", {
					type: "agent-message-delta",
					threadId: params.threadId,
					turnId: params.turnId,
					itemId: params.itemId,
					delta: params.delta ?? "",
				} satisfies CodexClientEvent);
				return;
			case "item/completed":
				if (params.item?.type === "agentMessage") {
					this.emit("event", {
						type: "agent-message-complete",
						threadId: params.threadId,
						turnId: params.turnId,
						itemId: params.item.id,
						text: params.item.text ?? "",
					} satisfies CodexClientEvent);
				}
				return;
			case "error":
				this.emit("event", {
					type: "error",
					threadId: params.threadId,
					message: params.error?.message ?? JSON.stringify(params),
				} satisfies CodexClientEvent);
				return;
			default:
				return;
		}
	}

	private failPending(message: string) {
		for (const pending of this.pending.values()) {
			pending.reject(new Error(message));
		}
		this.pending.clear();
	}
}
