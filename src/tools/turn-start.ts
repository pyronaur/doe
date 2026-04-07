export interface TurnRegistry {
	markThreadAttached(
		agentId: string,
		input: { threadId: string; activeTurnId?: string | null },
	): void;
	markTurnStarted(threadId: string, turnId: string): void;
	appendUserMessage(agentId: string, turnId: string, prompt: string): void;
}

export function recordStartedTurn(
	registry: TurnRegistry,
	input: { agentId: string; threadId: string; turnId: string; prompt: string },
) {
	registry.markThreadAttached(input.agentId, {
		threadId: input.threadId,
		activeTurnId: input.turnId,
	});
	registry.markTurnStarted(input.threadId, input.turnId);
	registry.appendUserMessage(input.agentId, input.turnId, input.prompt);
}
