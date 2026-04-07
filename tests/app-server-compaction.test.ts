import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/codex/app-server-client.ts";

function createMockClient() {
	const client = new CodexAppServerClient();
	const calls: Array<{ method: string; params: any }> = [];
	(client as any).ensureStarted = async () => {};
	(client as any).request = async (method: string, params: any) => {
		calls.push({ method, params });
		if (method === "thread/start" || method === "thread/resume") {
			return { thread: { id: "thread-1" } };
		}
		if (method === "turn/start") {
			return { turn: { id: "turn-1" } };
		}
		return {};
	};
	return { client, calls };
}

test("CodexAppServerClient emits compaction lifecycle events", () => {
	const client = new CodexAppServerClient();
	const events: Array<any> = [];
	client.on("event", (event) => events.push(event));

	(client as any).handleNotification("item/started", {
		threadId: "thread-1",
		turnId: "turn-1",
		item: { id: "item-1", type: "contextCompaction" },
	});
	(client as any).handleNotification("item/completed", {
		threadId: "thread-1",
		turnId: "turn-1",
		item: { id: "item-1", type: "contextCompaction" },
	});

	assert.deepEqual(
		events.map((event) => event.type),
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
		itemId: "item-1",
		source: "contextCompaction",
	});
});

test("CodexAppServerClient normalizes thread token usage updates to current context usage", () => {
	const client = new CodexAppServerClient();
	const events: Array<any> = [];
	client.on("event", (event) => events.push(event));

	(client as any).handleNotification("thread/tokenUsage/updated", {
		threadId: "thread-1",
		turnId: "turn-2",
		usage: { tokensUsed: 204000, tokenLimit: 258000 },
	});

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
	assert.equal((client as any).threadWriteAccess.get("thread-1"), false);

	calls.length = 0;
	await client.resumeThread({
		threadId: "thread-1",
		cwd: "/tmp",
		allowWrite: false,
	});

	assert.equal(calls[0]?.method, "thread/resume");
	assert.equal(calls[0]?.params.sandbox, "danger-full-access");
	assert.equal((client as any).threadWriteAccess.get("thread-1"), false);
});

test("CodexAppServerClient keeps turn sandbox and approval gates separate", async () => {
	const { client, calls } = createMockClient();
	const sent: Array<any> = [];
	(client as any).send = (message: any) => {
		sent.push(message);
	};

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
	await (client as any).handleServerRequest({
		id: 1,
		method: "item/commandExecution/requestApproval",
		params: { threadId: "thread-1" },
	});
	await (client as any).handleServerRequest({
		id: 2,
		method: "item/fileChange/requestApproval",
		params: { threadId: "thread-1" },
	});

	assert.deepEqual(sent[0], { id: 1, result: { decision: "decline" } });
	assert.deepEqual(sent[1], { id: 2, result: { decision: "decline" } });
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
