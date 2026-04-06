export function estimateCurrentTurnIndex(messages: readonly unknown[]): number {
	const completedTurns = messages.filter((message) => (message as { role?: unknown } | null)?.role === "assistant").length;
	return completedTurns + 1;
}

export function shouldInjectSessionSlugReminder(input: {
	sessionSlug: string | null;
	currentTurn: number;
	lastReminderTurn: number | null;
}): boolean {
	if (input.sessionSlug) return false;
	if (input.currentTurn < 3) return false;
	return input.lastReminderTurn !== input.currentTurn;
}
