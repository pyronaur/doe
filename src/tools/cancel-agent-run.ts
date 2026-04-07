import type { CodexAppServerClient } from "../codex/app-server-client.js";
import type { DoeRegistry } from "../state/registry.js";
import type { AgentRecord } from "../types.js";

export async function cancelAgentRun(input: {
	agent: AgentRecord;
	client: CodexAppServerClient;
	registry: DoeRegistry;
	note: string;
}): Promise<AgentRecord> {
	const current = input.registry.getAgent(input.agent.id) ?? input.agent;
	const interruptedTurnId = current.activeTurnId ?? null;

	if (current.threadId && interruptedTurnId) {
		try {
			await input.client.interruptTurn(current.threadId, interruptedTurnId);
		} catch {}
	}

	if (current.threadId) {
		try {
			await input.client.unsubscribeThread(current.threadId);
		} catch {}
	}

	return input.registry.cancelAgent(current.id, {
		note: input.note,
		interruptedTurnId,
	});
}
