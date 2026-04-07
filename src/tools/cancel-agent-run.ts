import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import type { AgentRecord } from "../roster/types.ts";

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
		} catch (error) {
			console.error("[doe/tools] Failed to interrupt cancelled turn:", error);
		}
	}

	if (current.threadId) {
		try {
			await input.client.unsubscribeThread(current.threadId);
		} catch (error) {
			console.error("[doe/tools] Failed to unsubscribe cancelled thread:", error);
		}
	}

	return input.registry.cancelAgent(current.id, {
		note: input.note,
		interruptedTurnId,
	});
}
