function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAssistantMessage(message: unknown): message is { role: "assistant" } {
	return isRecord(message) && message.role === "assistant";
}

export function estimateCurrentTurnIndex(messages: readonly unknown[]): number {
	const completedTurns = messages.filter(isAssistantMessage).length;
	return completedTurns + 1;
}

export function shouldInjectSessionSlugReminder(input: {
	sessionSlug: string | null;
	currentTurn: number;
	lastReminderTurn: number | null;
}): boolean {
	if (input.sessionSlug) { return false; }
	if (input.currentTurn < 3) { return false; }
	return input.lastReminderTurn !== input.currentTurn;
}
