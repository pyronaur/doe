function summarizeRecord(value: Record<string, any>): string | null {
	const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : null;
	const code =
		typeof value.code === "string" && value.code.trim().length > 0
			? value.code.trim()
			: typeof value.code === "number" && Number.isFinite(value.code)
				? String(value.code)
				: null;

	const nested = [
		value.message,
		value.reason,
		value.error,
		value.detail,
	].map((entry) => summarizeErrorText(entry)).find((entry) => entry.length > 0) ?? "";

	if (nested) {
		if (name) {
			return code ? `${name} (${code}): ${nested}` : `${name}: ${nested}`;
		}
		return nested;
	}

	if (name) {
		return code ? `${name} (${code})` : name;
	}

	if (code) {
		return `Error ${code}`;
	}

	return null;
}

export function summarizeErrorText(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return "";
		if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
			try {
				return summarizeErrorText(JSON.parse(trimmed));
			} catch {}
		}
		return trimmed;
	}

	if (value instanceof Error) {
		return summarizeErrorText({
			name: value.name,
			message: value.message,
			code: (value as Error & { code?: unknown }).code,
		});
	}

	if (!value || typeof value !== "object") {
		return String(value ?? "");
	}

	const summarized = summarizeRecord(value as Record<string, any>);
	return summarized ?? "Codex worker error";
}
