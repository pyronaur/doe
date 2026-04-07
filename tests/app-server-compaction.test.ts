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
