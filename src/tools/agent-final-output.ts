function isQueuedPlaceholder(text: string): boolean {
	return text.trim().startsWith("queued:");
}

export function resolveAgentFinalOutput(agent: any, fallback: string | null = "Completed") {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) =>
			message?.role === "agent" && typeof message?.text === "string"
			&& message.text.trim().length > 0
		)?.text;
	const latestFinalOutput = typeof agent?.latestFinalOutput === "string"
		? agent.latestFinalOutput
		: null;
	if (latestFinalOutput && !isQueuedPlaceholder(latestFinalOutput)) {
		return latestFinalOutput;
	}
	if (lastAgentMessage && !isQueuedPlaceholder(lastAgentMessage)) {
		return lastAgentMessage;
	}
	const latestSnippet = typeof agent?.latestSnippet === "string" ? agent.latestSnippet : null;
	if (latestSnippet && !isQueuedPlaceholder(latestSnippet)) {
		return latestSnippet;
	}
	return fallback;
}
