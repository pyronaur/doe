function normalizeTaskName(name: unknown): string | null {
	if (typeof name !== "string") return null;
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function inferName(prompt: string): string {
	const words = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2);
	return words.join(" ") || "delegate";
}

export function normalizeSpawnSeatIntent(
	task: { name?: unknown; ic?: unknown; prompt: string },
	hasSeat: (name: string) => boolean,
): { ic: string | null; taskName: string } {
	const explicitIc = normalizeTaskName(task.ic);
	if (explicitIc) {
		return {
			ic: explicitIc,
			taskName: normalizeTaskName(task.name) ?? inferName(task.prompt),
		};
	}

	const implicitIc = normalizeTaskName(task.name);
	if (implicitIc && hasSeat(implicitIc)) {
		return {
			ic: implicitIc,
			taskName: inferName(task.prompt),
		};
	}

	return {
		ic: null,
		taskName: normalizeTaskName(task.name) ?? inferName(task.prompt),
	};
}
