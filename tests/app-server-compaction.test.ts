import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/codex/app-server-client.ts";
import { test } from "./test-runner.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setMethod(
	target: CodexAppServerClient,
	name: string,
	handler: (...args: unknown[]) => unknown,
): void {
	Reflect.set(target, name, handler);
}

function callMethod(target: CodexAppServerClient, name: string, args: unknown[]): unknown {
	const handler = Reflect.get(target, name);
	if (typeof handler !== "function") {
		throw new Error(`Expected ${name} to be a function.`);
	}
	return Reflect.apply(handler, target, args);
}

function readThreadWriteAccess(target: CodexAppServerClient, threadId: string): unknown {
	const table = Reflect.get(target, "threadWriteAccess");
	if (!(table instanceof Map)) {
		throw new Error("Expected threadWriteAccess to be a map.");
	}
	return table.get(threadId);
}

function createMockClient() {
	const client = new CodexAppServerClient();
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	setMethod(client, "ensureStarted", async () => {});
	setMethod(client, "request", async (method, params) => {
		const methodName = typeof method === "string" ? method : "";
		const requestParams = isRecord(params) ? params : {};
		calls.push({ method: methodName, params: requestParams });
		if (method === "thread/start" || method === "thread/resume") {
			return { thread: { id: "thread-1" } };
		}
		if (method === "turn/start") {
			return { turn: { id: "turn-1" } };
		}
		return {};
	});
	return { client, calls };
}

test("CodexAppServerClient emits compaction lifecycle events", () => {
	const client = new CodexAppServerClient();
	const events: unknown[] = [];
	client.on("event", (event) => events.push(event));

	callMethod(client, "handleNotification", ["item/started", {
		threadId: "thread-1",
		turnId: "turn-1",
		item: { id: "item-1", type: "contextCompaction" },
	}]);
	callMethod(client, "handleNotification", ["item/completed", {
		threadId: "thread-1",
		turnId: "turn-1",
		item: { id: "item-1", type: "contextCompaction" },
	}]);

	assert.deepEqual(
		events.map((event) => (isRecord(event) ? event.type : undefined)),
		["thread-compaction-started", "thread-compaction-completed"],
	);
	assert.deepEqual(events[0], {
		type: "thread-compaction-started",
		threadId: "thread-1",
		turnId: "turn-1",
		itemId: "item-1",
	});
	assert.deepEqual(events[1], {
		type: "thread-compaction-completed",
		threadId: "thread-1",
		turnId: "turn-1",
		itemId: null,
		source: "contextCompaction",
	});
});

test("CodexAppServerClient normalizes thread token usage updates to current context usage", () => {
	const client = new CodexAppServerClient();
	const events: unknown[] = [];
	client.on("event", (event) => events.push(event));

	callMethod(client, "handleNotification", ["thread/tokenUsage/updated", {
		threadId: "thread-1",
		turnId: "turn-2",
		usage: { tokensUsed: 204000, tokenLimit: 258000 },
	}]);

	assert.deepEqual(events[0], {
		type: "thread-token-usage",
		threadId: "thread-1",
		turnId: "turn-2",
		usage: { tokensUsed: 204000, tokenLimit: 258000 },
	});
});

test("CodexAppServerClient starts worker threads with full access by default", async () => {
	const { client, calls } = createMockClient();

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		approvalPolicy: "never",
	});

	assert.equal(calls[0]?.method, "thread/start");
	assert.equal(calls[0]?.params.model, "gpt-5.4");
	assert.equal(calls[0]?.params.sandbox, "danger-full-access");
});

test("CodexAppServerClient resumes worker threads with full access by default", async () => {
	const { client, calls } = createMockClient();

	await client.resumeThread({
		threadId: "thread-1",
		cwd: "/tmp",
	});

	assert.equal(calls[0]?.method, "thread/resume");
	assert.equal(calls[0]?.params.sandbox, "danger-full-access");
});

test("CodexAppServerClient keeps sandbox full access when allowWrite is false", async () => {
	const { client, calls } = createMockClient();

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		approvalPolicy: "never",
		allowWrite: false,
	});

	assert.equal(calls[0]?.method, "thread/start");
	assert.equal(calls[0]?.params.sandbox, "danger-full-access");
	assert.equal(readThreadWriteAccess(client, "thread-1"), false);

	calls.length = 0;
	await client.resumeThread({
		threadId: "thread-1",
		cwd: "/tmp",
		allowWrite: false,
	});

	assert.equal(calls[0]?.method, "thread/resume");
	assert.equal(calls[0]?.params.sandbox, "danger-full-access");
	assert.equal(readThreadWriteAccess(client, "thread-1"), false);
});

test("CodexAppServerClient keeps turn sandbox and approval gates separate", async () => {
	const { client, calls } = createMockClient();
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		approvalPolicy: "never",
		allowWrite: false,
	});
	calls.length = 0;

	await client.startTurn({
		threadId: "thread-1",
		prompt: "hello",
		cwd: "/tmp",
		model: "gpt-5.4",
		allowWrite: false,
	});

	assert.equal(calls[0]?.method, "turn/start");
	assert.deepEqual(calls[0]?.params.sandboxPolicy, { type: "dangerFullAccess" });

	sent.length = 0;
	await Promise.resolve(
		callMethod(client, "handleServerRequest", [1, "item/commandExecution/requestApproval", {
			threadId: "thread-1",
		}]),
	);
	await Promise.resolve(
		callMethod(client, "handleServerRequest", [2, "item/fileChange/requestApproval", {
			threadId: "thread-1",
		}]),
	);

	assert.deepEqual(sent[0], { id: 1, result: { decision: "decline" } });
	assert.deepEqual(sent[1], { id: 2, result: { decision: "decline" } });
});

test("CodexAppServerClient grants requested permissions when approved", async () => {
	const client = new CodexAppServerClient({
		requestPermissionApproval: async (request) => {
			assert.equal(request.threadId, "thread-1");
			assert.equal(request.turnId, "turn-1");
			assert.equal(request.itemId, "item-1");
			assert.equal(request.reason, "Need write access for this patch");
			return { approved: true };
		},
	});
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await Promise.resolve(
		callMethod(client, "handleServerRequest", [3, "item/permissions/requestApproval", {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "item-1",
			reason: "Need write access for this patch",
			permissions: {
				fileSystem: { write: ["/tmp/target.ts"] },
				network: { enabled: true },
			},
		}]),
	);

	assert.deepEqual(sent[0], {
		id: 3,
		result: {
			permissions: {
				fileSystem: { write: ["/tmp/target.ts"] },
				network: { enabled: true },
			},
			scope: "turn",
		},
	});
});

test("CodexAppServerClient denies requested permissions when declined", async () => {
	const client = new CodexAppServerClient({
		requestPermissionApproval: async () => ({ approved: false }),
	});
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await Promise.resolve(
		callMethod(client, "handleServerRequest", [4, "item/permissions/requestApproval", {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "item-2",
			permissions: {
				fileSystem: { read: ["/tmp/data.json"] },
			},
		}]),
	);

	assert.deepEqual(sent[0], {
		id: 4,
		result: {
			permissions: {},
			scope: "turn",
		},
	});
});

test("CodexAppServerClient treats missing permission reason as null", async () => {
	const client = new CodexAppServerClient({
		requestPermissionApproval: async (request) => {
			assert.equal(request.reason, null);
			return { approved: false };
		},
	});
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await Promise.resolve(
		callMethod(client, "handleServerRequest", [5, "item/permissions/requestApproval", {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "item-3",
			permissions: {
				fileSystem: { read: ["/tmp/readme.md"] },
			},
		}]),
	);

	assert.deepEqual(sent[0], {
		id: 5,
		result: {
			permissions: {},
			scope: "turn",
		},
	});
});

test("CodexAppServerClient supports partial permission approval", async () => {
	const client = new CodexAppServerClient({
		requestPermissionApproval: async () => ({
			approved: true,
			permissions: {
				fileSystem: { read: ["/tmp/safe-read-only.txt"] },
			},
			scope: "session",
		}),
	});
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await Promise.resolve(
		callMethod(client, "handleServerRequest", [6, "item/permissions/requestApproval", {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "item-4",
			permissions: {
				fileSystem: {
					read: ["/tmp/safe-read-only.txt"],
					write: ["/tmp/blocked-write.txt"],
				},
				network: { enabled: true },
			},
		}]),
	);

	assert.deepEqual(sent[0], {
		id: 6,
		result: {
			permissions: {
				fileSystem: { read: ["/tmp/safe-read-only.txt"] },
			},
			scope: "session",
		},
	});
});

test("CodexAppServerClient denies malformed permission approval requests without crashing", async () => {
	let callbackCalls = 0;
	const client = new CodexAppServerClient({
		requestPermissionApproval: async () => {
			callbackCalls += 1;
			return { approved: true };
		},
	});
	const sent: unknown[] = [];
	setMethod(client, "send", (message) => {
		sent.push(message);
	});

	await Promise.resolve(
		callMethod(client, "handleServerRequest", [7, "item/permissions/requestApproval", {
			turnId: "turn-1",
			permissions: {
				fileSystem: { write: ["/tmp/target.ts"] },
			},
		}]),
	);

	assert.equal(callbackCalls, 0);
	assert.deepEqual(sent[0], {
		id: 7,
		result: {
			permissions: {},
			scope: "turn",
		},
	});
});

test("CodexAppServerClient forwards read-only sandbox settings", async () => {
	const { client, calls } = createMockClient();

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		approvalPolicy: "never",
		sandbox: "read-only",
		networkAccess: true,
	});

	assert.equal(calls[0]?.method, "thread/start");
	assert.equal(calls[0]?.params.sandbox, "read-only");

	calls.length = 0;
	await client.resumeThread({
		threadId: "thread-1",
		cwd: "/tmp",
		sandbox: "read-only",
	});

	assert.equal(calls[0]?.method, "thread/resume");
	assert.equal(calls[0]?.params.sandbox, "read-only");

	calls.length = 0;
	await client.startTurn({
		threadId: "thread-1",
		prompt: "hello",
		cwd: "/tmp",
		model: "gpt-5.4",
		sandbox: "read-only",
		networkAccess: true,
	});

	assert.equal(calls[0]?.method, "turn/start");
	assert.deepEqual(calls[0]?.params.sandboxPolicy, {
		type: "readOnly",
		access: { type: "fullAccess" },
		networkAccess: true,
	});
});

test("CodexAppServerClient forwards workspace-write sandbox settings", async () => {
	const { client, calls } = createMockClient();

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		approvalPolicy: "never",
		sandbox: "workspace-write",
		networkAccess: true,
	});

	assert.equal(calls[0]?.method, "thread/start");
	assert.equal(calls[0]?.params.sandbox, "workspace-write");

	calls.length = 0;
	await client.resumeThread({
		threadId: "thread-1",
		cwd: "/tmp",
		sandbox: "workspace-write",
	});

	assert.equal(calls[0]?.method, "thread/resume");
	assert.equal(calls[0]?.params.sandbox, "workspace-write");

	calls.length = 0;
	await client.startTurn({
		threadId: "thread-1",
		prompt: "hello",
		cwd: "/tmp",
		model: "gpt-5.4",
		sandbox: "workspace-write",
		networkAccess: true,
	});

	assert.equal(calls[0]?.method, "turn/start");
	assert.deepEqual(calls[0]?.params.sandboxPolicy, {
		type: "workspaceWrite",
		writableRoots: [],
		networkAccess: true,
		excludeTmpdirEnvVar: false,
		excludeSlashTmp: false,
	});
});

test("CodexAppServerClient reads context usage via thread/read", async () => {
	const { client, calls } = createMockClient();
	const usage = await client.readContextWindowUsage("thread-1", "turn-1");

	assert.deepEqual(usage, null);
	assert.equal(calls[0]?.method, "thread/read");
	assert.deepEqual(calls[0]?.params, {
		threadId: "thread-1",
		includeTurns: false,
	});
});

test("CodexAppServerClient parses usage from thread/read top-level usage", async () => {
	const client = new CodexAppServerClient();
	setMethod(client, "ensureStarted", async () => {});
	setMethod(client, "request", async (method, _params) => {
		if (method === "thread/read") {
			return {
				usage: {
					last_token_usage: { total_tokens: 1234 },
					model_context_window: 20000,
				},
			};
		}
		return {};
	});

	const usage = await client.readContextWindowUsage("thread-1", null);
	assert.deepEqual(usage, { tokensUsed: 1234, tokenLimit: 20000 });
});

test("CodexAppServerClient parses usage from thread/read thread.tokenUsage", async () => {
	const client = new CodexAppServerClient();
	setMethod(client, "ensureStarted", async () => {});
	setMethod(client, "request", async (method, _params) => {
		if (method === "thread/read") {
			return {
				thread: {
					tokenUsage: {
						last: { totalTokens: 4321 },
						total: { totalTokens: 4500 },
						modelContextWindow: 64000,
					},
				},
			};
		}
		return {};
	});

	const usage = await client.readContextWindowUsage("thread-1");
	assert.deepEqual(usage, { tokensUsed: 4321, tokenLimit: 64000 });
});
