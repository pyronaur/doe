import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DoeRegistry } from "../state/registry.js";

function formatElapsed(startedAt: number, completedAt?: number | null): string {
	const end = completedAt ?? Date.now();
	const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins >= 60) {
		const hours = Math.floor(mins / 60);
		return `${hours}h ${mins % 60}m`;
	}
	return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function pad(text: string, width: number): string {
	const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
	if (stripped.length >= width) return stripped.slice(0, width);
	return stripped + " ".repeat(width - stripped.length);
}

function wrapPlainText(text: string, width: number, maxLines: number): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const wrapped: string[] = [];
	let truncated = false;
	const pushWrappedLine = (line: string) => {
		const source = line.trimEnd();
		if (source.length === 0) {
			if (wrapped.length >= maxLines) {
				truncated = true;
				return;
			}
			wrapped.push("");
			return;
		}
		let remaining = source;
		while (remaining.length > width) {
			if (wrapped.length >= maxLines) {
				truncated = true;
				return;
			}
			let slice = remaining.slice(0, width);
			const breakAt = slice.lastIndexOf(" ");
			if (breakAt >= Math.max(8, Math.floor(width * 0.4))) {
				slice = slice.slice(0, breakAt);
			}
			wrapped.push(slice);
			remaining = remaining.slice(slice.length).trimStart();
		}
		if (wrapped.length >= maxLines) {
			truncated = true;
			return;
		}
		wrapped.push(remaining);
	};

	for (const [index, line] of lines.entries()) {
		pushWrappedLine(line);
		if (wrapped.length >= maxLines && index < lines.length - 1) {
			truncated = true;
			break;
		}
	}

	const normalized = wrapped.slice(0, maxLines);
	if (normalized.length === 0) return [""];
	if (truncated) {
		const lastIndex = normalized.length - 1;
		const last = normalized[lastIndex] ?? "";
		normalized[lastIndex] = last.length >= width ? `${last.slice(0, Math.max(0, width - 1))}…` : `${last}…`;
	}
	return normalized;
}

class SidebarComponent {
	constructor(private readonly registry: DoeRegistry, private readonly theme: any) {}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const inner = Math.max(18, width - 2);
		const messageWidth = Math.max(12, inner - 1);
		const agents = this.registry.listAgents({ includeCompleted: true, limit: 6 });
		const activeCount = agents.filter((agent) => agent.state === "working").length;
		const title = ` DoE agents (${activeCount} active) `;
		const borderLeft = th.fg("border", "│");
		const remaining = Math.max(0, inner - title.length);
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		const borderTop = th.fg("border", `╭${"─".repeat(left)}${title}${"─".repeat(right)}╮`);
		lines.push(borderTop);

		if (agents.length === 0) {
			lines.push(borderLeft + th.fg("dim", pad(" No active or recent agents yet", inner)) + th.fg("border", "│"));
			lines.push(borderLeft + th.fg("dim", pad(" Use codex_spawn to delegate work", inner)) + th.fg("border", "│"));
		} else {
			for (const [index, agent] of agents.entries()) {
				const statusColor =
					agent.state === "completed"
						? "success"
						: agent.state === "error"
							? "error"
							: agent.state === "awaiting_input"
								? "warning"
								: "accent";
				const heading = `${agent.name} · ${agent.model}`;
				const meta = agent.state === "working"
					? `${agent.activityLabel ?? agent.state} · ${formatElapsed(agent.startedAt, agent.completedAt)}`
					: `${agent.state} · ${formatElapsed(agent.startedAt, agent.completedAt)}`;
				const snippet = agent.latestFinalOutput || agent.latestSnippet || "(waiting for message output)";
				const snippetLines = wrapPlainText(snippet, messageWidth, 8);
				lines.push(borderLeft + th.fg("accent", pad(` ${heading}`, inner)) + th.fg("border", "│"));
				lines.push(borderLeft + th.fg(statusColor, pad(` ${meta}`, inner)) + th.fg("border", "│"));
				for (const snippetLine of snippetLines) {
					lines.push(borderLeft + th.fg("muted", pad(` ${snippetLine}`, inner)) + th.fg("border", "│"));
				}
				if (index < agents.length - 1) {
					lines.push(borderLeft + th.fg("border", "─".repeat(inner)) + th.fg("border", "│"));
				}
			}
		}

		lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export class AgentSidebarController {
	private handle: any = null;
	private component: SidebarComponent | null = null;
	private opened = false;
	private hidden = false;
	private ticker: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly registry: DoeRegistry) {}

	open(ctx: ExtensionContext) {
		if (!ctx.hasUI || this.opened) return;
		this.opened = true;
		ctx.ui.custom(
			(_tui, theme, _kb, _done) => {
				this.component = new SidebarComponent(this.registry, theme);
				return this.component as any;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "28%",
					minWidth: 36,
					maxHeight: "80%",
					margin: { right: 1 },
					visible: (termWidth: number) => termWidth >= 110,
				},
				onHandle: (handle: any) => {
					this.handle = handle;
					if (typeof handle.unfocus === "function") {
						handle.unfocus();
					}
				},
			},
		);
		if (!this.ticker) {
			this.ticker = setInterval(() => this.requestRender(), 1000);
		}
	}

	toggle() {
		if (!this.handle || typeof this.handle.setHidden !== "function") return;
		this.hidden = !this.hidden;
		this.handle.setHidden(this.hidden);
	}

	requestRender() {
		if (this.handle && typeof this.handle.requestRender === "function") {
			this.handle.requestRender();
		}
	}

	close() {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
		if (this.handle && typeof this.handle.close === "function") {
			this.handle.close();
		}
		this.handle = null;
		this.component = null;
		this.opened = false;
	}
}
