import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/codex/app-server-client.ts";

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

test("CodexAppServerClient always requests danger-full-access sandboxing for worker threads", async () => {
	const client = new CodexAppServerClient();
	const calls: Array<{ method: string; params: any }> = [];
	(client as any).ensureStarted = async () => {};
	(client as any).request = async (method: string, params: any) => {
		calls.push({ method, params });
		return { thread: { id: "thread-1" } };
	};

	await client.startThread({
		model: "gpt-5.4",
		cwd: "/tmp",
		allowWrite: false,
	});
	await client.resumeThread({
		threadId: "thread-1",
		model: "gpt-5.4",
		cwd: "/tmp",
		allowWrite: false,
	});

	assert.deepEqual(calls.map((call) => call.method), ["thread/start", "thread/resume"]);
	assert.deepEqual(calls[0]?.params.sandbox, { type: "dangerFullAccess" });
	assert.deepEqual(calls[1]?.params.sandbox, { type: "dangerFullAccess" });
});

test("CodexAppServerClient renders malformed worker errors as short text", () => {
	const client = new CodexAppServerClient();
	const events: Array<any> = [];
	client.on("event", (event) => events.push(event));

	(client as any).handleNotification("error", {
		threadId: "thread-1",
		error: {
			name: "SpawnError",
			details: {
				command: "codex",
				args: ["app-server"],
			},
		},
	});

	assert.deepEqual(events[0], {
		type: "error",
		threadId: "thread-1",
		message: "SpawnError",
	});
});
