import { Text } from "@mariozechner/pi-tui";

export function renderToolResultText(theme: any, result: any, fallback: string) {
	return new Text(theme.fg("accent", result.content?.[0]?.text ?? fallback), 0, 0);
}
