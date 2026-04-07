import { formatCompactionSignal } from "../context-usage.ts";

export function formatContextStatusLines(compaction: unknown): string[] {
	const signal = formatCompactionSignal(compaction);
	if (!signal) {
		return [];
	}
	return [`context_status: ${signal}`];
}
