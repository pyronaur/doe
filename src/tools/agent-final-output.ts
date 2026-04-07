export function resolveAgentFinalOutput(agent: any, fallback: string | null = "Completed") {
	const lastAgentMessage = [...(agent?.messages ?? [])]
		.reverse()
		.find((message: any) =>
			message?.role === "agent" && typeof message?.text === "string"
			&& message.text.trim().length > 0
		)?.text;
	return agent?.latestFinalOutput ?? lastAgentMessage ?? agent?.latestSnippet ?? fallback;
}
