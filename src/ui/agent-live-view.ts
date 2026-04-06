import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { extractThreadTranscript, truncateForDisplay } from "../codex/client.js";
import type { CodexAppServerClient } from "../codex/app-server-client.js";
import type { AgentRecord, DoeRegistry } from "../state/registry.js";

type ViewMode = "list" | "detail";

interface AgentLiveViewOptions {
	registry: DoeRegistry;
	client: CodexAppServerClient;
	theme: any;
	done: (value?: unknown) => void;
	requestRender: () => void;
	initialMode?: ViewMode;
	initialAgentId?: string | null;
}

function stateRank(agent: AgentRecord): number {
	if (agent.state === "working") return 0;
	if (agent.state === "awaiting_input") return 1;
	return 2;
}

function sortAgents(agents: AgentRecord[]): AgentRecord[] {
	return [...agents].sort((a, b) => {
		const rankDiff = stateRank(a) - stateRank(b);
		if (rankDiff !== 0) return rankDiff;
		return b.startedAt - a.startedAt;
	});
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [""];
	const source = text.replace(/\r\n?/g, "\n").split("\n");
	const lines: string[] = [];

	for (const rawLine of source) {
		const line = rawLine.trimEnd();
		if (!line) {
			lines.push("");
			continue;
		}
		let rest = line;
		while (rest.length > width) {
			let chunk = rest.slice(0, width);
			const breakAt = chunk.lastIndexOf(" ");
			if (breakAt >= Math.max(8, Math.floor(width * 0.4))) {
				chunk = chunk.slice(0, breakAt);
			}
			lines.push(chunk);
			rest = rest.slice(chunk.length).trimStart();
		}
		lines.push(rest);
	}

	return lines.length > 0 ? lines : [""];
}

function formatTimestamp(value: number | null | undefined): string {
	if (!value) return "n/a";
	return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatElapsed(startedAt: number, completedAt?: number | null): string {
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

function listViewportSize(): number {
	const rows = process.stdout.rows ?? 32;
	return Math.max(8, Math.min(18, rows - 10));
}

function detailViewportSize(): number {
	return 12;
}

function agentMeta(agent: AgentRecord): string {
	const state = agent.activityLabel ?? agent.state;
	return `${state} | ${agent.model} | ${formatElapsed(agent.startedAt, agent.completedAt)}`;
}

function sectionLabel(agent: AgentRecord): string {
	if (agent.state === "working") return "ACTIVE";
	if (agent.state === "awaiting_input") return "AWAITING INPUT";
	return "RECENT";
}

class AgentLiveViewComponent {
	private readonly registry: DoeRegistry;
	private readonly client: CodexAppServerClient;
	private readonly theme: any;
	private readonly done: (value?: unknown) => void;
	private readonly requestRender: () => void;
	private mode: ViewMode = "list";
	private selectedAgentId: string | null = null;
	private detailAgentId: string | null = null;
	private detailScrollTop: number | null = null;
	private detailBodyWidth = 80;
	private hydratingAgentId: string | null = null;
	private hydrationError: string | null = null;

	constructor(options: AgentLiveViewOptions) {
		this.registry = options.registry;
		this.client = options.client;
		this.theme = options.theme;
		this.done = options.done;
		this.requestRender = options.requestRender;
		this.selectedAgentId = options.initialAgentId ?? this.getInitialSelection();
		if (options.initialMode === "detail" && this.selectedAgentId) {
			this.mode = "detail";
			this.detailAgentId = this.selectedAgentId;
			void this.ensureInitialDetail();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+,")) {
			this.close();
			return;
		}
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		return this.mode === "detail" ? this.renderDetail(width) : this.renderList(width);
	}

	invalidate(): void {}

	dispose(): void {}

	private getAgents(): AgentRecord[] {
		return sortAgents(this.registry.listAgents({ includeCompleted: true }));
	}

	private getInitialSelection(): string | null {
		const agents = this.getAgents();
		const firstActive = agents.find((agent) => agent.state === "working");
		return firstActive?.id ?? agents[0]?.id ?? null;
	}

	private ensureSelection(): AgentRecord[] {
		const agents = this.getAgents();
		if (agents.length === 0) {
			this.selectedAgentId = null;
			return agents;
		}
		if (!this.selectedAgentId || !agents.some((agent) => agent.id === this.selectedAgentId)) {
			this.selectedAgentId = this.getInitialSelection();
		}
		return agents;
	}

	private selectedAgent(agents: AgentRecord[]): AgentRecord | null {
		if (!this.selectedAgentId) return null;
		return agents.find((agent) => agent.id === this.selectedAgentId) ?? null;
	}

	private moveSelection(delta: number) {
		const agents = this.ensureSelection();
		if (agents.length === 0) return;
		const currentIndex = Math.max(0, agents.findIndex((agent) => agent.id === this.selectedAgentId));
		const nextIndex = Math.max(0, Math.min(agents.length - 1, currentIndex + delta));
		this.selectedAgentId = agents[nextIndex]!.id;
		this.requestRender();
	}

	private moveSelectionTo(index: number) {
		const agents = this.ensureSelection();
		if (agents.length === 0) return;
		const nextIndex = Math.max(0, Math.min(agents.length - 1, index));
		this.selectedAgentId = agents[nextIndex]!.id;
		this.requestRender();
	}

	private openDetail() {
		const agents = this.ensureSelection();
		const agent = this.selectedAgent(agents);
		if (!agent) return;
		this.mode = "detail";
		this.detailAgentId = agent.id;
		this.detailScrollTop = null;
		this.hydrationError = null;
		void this.ensureHistory(agent);
		this.requestRender();
	}

	private async ensureHistory(agent: AgentRecord) {
		if (!agent.threadId) return;
		if (agent.historyHydratedAt) return;
		if (this.hydratingAgentId === agent.id) return;
		this.hydratingAgentId = agent.id;
		this.requestRender();
		try {
			const threadResponse = await this.client.readThread(agent.threadId, true);
			const messages = extractThreadTranscript(threadResponse.thread);
			this.registry.hydrateAgentMessages(agent.id, messages);
			this.hydrationError = null;
		} catch (error) {
			this.hydrationError = error instanceof Error ? error.message : String(error);
		} finally {
			this.hydratingAgentId = null;
			this.requestRender();
		}
	}

	private async ensureInitialDetail() {
		const agent = this.detailAgentId ? this.registry.getAgent(this.detailAgentId) : null;
		if (!agent) return;
		await this.ensureHistory(agent);
	}

	private backToList() {
		this.mode = "list";
		this.detailAgentId = null;
		this.detailScrollTop = null;
		this.hydrationError = null;
		this.requestRender();
	}

	private close() {
		this.done(null);
	}

	private handleListInput(data: string) {
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.moveSelectionTo(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.moveSelectionTo(Number.MAX_SAFE_INTEGER);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openDetail();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.close();
		}
	}

	private handleDetailInput(data: string) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "h") {
			this.backToList();
			return;
		}

		const step = matchesKey(data, "pageup") ? -8 : matchesKey(data, "pagedown") ? 8 : matchesKey(data, Key.up) || data === "k" ? -1 : matchesKey(data, Key.down) || data === "j" ? 1 : 0;
		if (step === 0) return;
		this.scrollDetail(step);
	}

	private scrollDetail(delta: number) {
		const agent = this.detailAgentId ? this.registry.getAgent(this.detailAgentId) : null;
		if (!agent) return;
		const lines = this.buildDetailBodyLines(agent, this.detailBodyWidth);
		const maxStart = Math.max(0, lines.length - detailViewportSize());
		const current = this.detailScrollTop ?? maxStart;
		const next = Math.max(0, Math.min(maxStart, current + delta));
		this.detailScrollTop = next >= maxStart ? null : next;
		this.requestRender();
	}

	private renderFrame(title: string, width: number, body: string[]): string[] {
		const inner = Math.max(20, width - 2);
		const titleText = ` ${title} `;
		const titleWidth = Math.min(inner, titleText.length);
		const trimmedTitle = titleText.length > titleWidth ? `${titleText.slice(0, titleWidth - 1)}…` : titleText;
		const sideWidth = Math.max(0, inner - trimmedTitle.length);
		const left = Math.floor(sideWidth / 2);
		const right = sideWidth - left;
		const top = this.theme.fg("border", `╭${"─".repeat(left)}${trimmedTitle}${"─".repeat(right)}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(inner)}╯`);
		const lines = [top];
		for (const line of body) {
			const content = truncateToWidth(line, inner);
			const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
			lines.push(`${this.theme.fg("border", "│")}${content}${padding}${this.theme.fg("border", "│")}`);
		}
		lines.push(bottom);
		return lines;
	}

	private renderList(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const agents = this.ensureSelection();
		const body: string[] = [];
		if (agents.length === 0) {
			body.push(this.theme.fg("dim", " No agents yet"));
			body.push(this.theme.fg("dim", " Use codex_spawn to delegate work"));
			return this.renderFrame("DoE Live Monitor", width, body);
		}

		const selectedId = this.selectedAgentId;
		const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.id === selectedId));
		const pageSize = listViewportSize();
		const pageStart = Math.max(0, Math.min(selectedIndex, Math.max(0, agents.length - pageSize)));
		const page = agents.slice(pageStart, pageStart + pageSize);
		const activeCount = agents.filter((agent) => agent.state === "working").length;
		const waitingCount = agents.filter((agent) => agent.state === "awaiting_input").length;
		const recentCount = Math.max(0, agents.length - activeCount - waitingCount);

		body.push(this.theme.fg("accent", ` Active ${activeCount} | Awaiting ${waitingCount} | Recent ${recentCount}`));
		body.push(this.theme.fg("muted", " Up/Down move | Enter detail | Esc close"));
		body.push("");

		let lastSection: string | null = null;
		for (const [offset, agent] of page.entries()) {
			const absoluteIndex = pageStart + offset;
			const selected = agent.id === selectedId;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const section = sectionLabel(agent);
			if (section !== lastSection) {
				body.push(this.theme.fg("warning", ` ${section}`));
				lastSection = section;
			}
			const title = truncateToWidth(`${absoluteIndex + 1}. ${agent.name}`, inner - 2);
			const meta = truncateToWidth(agentMeta(agent), inner - 2);
			const preview = truncateToWidth(truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, inner - 6) || "(no transcript yet)", inner - 2);
			body.push(`${marker} ${selected ? this.theme.fg("accent", title) : title}`);
			body.push(`  ${selected ? this.theme.fg("warning", meta) : this.theme.fg("muted", meta)}`);
			body.push(`  ${this.theme.fg("dim", preview)}`);
			if (absoluteIndex < agents.length - 1) body.push(this.theme.fg("border", "─".repeat(Math.max(0, inner - 1))));
		}

		return this.renderFrame("DoE Live Monitor", width, body);
	}

	private buildDetailBodyLines(agent: AgentRecord, width: number): string[] {
		const lines: string[] = [];
		const messages = agent.messages.length > 0 ? agent.messages : this.registry.getAgentMessages(agent.id);
		const messageWidth = Math.max(16, width - 4);

		if (this.hydratingAgentId === agent.id) {
			lines.push(this.theme.fg("warning", " Hydrating history from thread/read..."));
			lines.push("");
		} else if (this.hydrationError) {
			lines.push(this.theme.fg("error", ` History hydration failed: ${truncateForDisplay(this.hydrationError, width - 4)}`));
			lines.push("");
		}

		if (messages.length === 0) {
			lines.push(this.theme.fg("dim", " No captured conversation history yet."));
			return lines;
		}

		for (const message of messages) {
			const label = message.role === "user" ? "USER" : "AGENT";
			const suffix = message.streaming ? " • streaming" : "";
			lines.push(this.theme.fg(message.role === "user" ? "accent" : "success", ` ${label}${suffix}`));
			for (const textLine of wrapText(message.text || "(empty)", messageWidth)) {
				lines.push(`   ${textLine}`);
			}
			lines.push("");
		}

		return lines;
	}

	private renderDetail(width: number): string[] {
		const inner = Math.max(20, width - 2);
		this.detailBodyWidth = inner;
		const agent = this.detailAgentId ? this.registry.getAgent(this.detailAgentId) : null;
		if (!agent) {
			return this.renderList(width);
		}

		const body: string[] = [];
		body.push(this.theme.fg("accent", ` ${agent.name}`));
		body.push(` ${agent.activityLabel ?? agent.state} | ${agent.model} | ${agent.allowWrite ? "write" : "read-only"}`);
		body.push(` cwd: ${truncateForDisplay(agent.cwd, inner - 6)}`);
		body.push(` started: ${formatTimestamp(agent.startedAt)} | completed: ${formatTimestamp(agent.completedAt ?? null)}`);
		body.push(this.theme.fg("muted", " Esc/Left back | Up/Down scroll"));
		body.push(this.theme.fg("border", "─".repeat(Math.max(0, inner - 1))));

		const contentLines = this.buildDetailBodyLines(agent, inner);
		const viewport = detailViewportSize();
		const maxStart = Math.max(0, contentLines.length - viewport);
		const start = this.detailScrollTop ?? maxStart;
		for (const line of contentLines.slice(start, start + viewport)) {
			body.push(line);
		}
		if (contentLines.length > viewport) {
			body.push(this.theme.fg("muted", ` ${Math.min(start + viewport, contentLines.length)}/${contentLines.length}`));
		}

		return this.renderFrame("Agent Detail", width, body);
	}
}

export class AgentLiveViewController {
	private handle: any = null;
	private opened = false;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private nextOpen: { mode?: ViewMode; agentId?: string | null } | null = null;

	constructor(
		private readonly registry: DoeRegistry,
		private readonly client: CodexAppServerClient,
	) {}

	toggle(ctx: ExtensionContext, nextOpen: { mode?: ViewMode; agentId?: string | null } = {}) {
		if (this.opened) {
			this.close();
			return;
		}
		this.open(ctx, nextOpen);
	}

	openList(ctx: ExtensionContext) {
		if (this.opened) {
			this.close();
		}
		this.open(ctx, { mode: "list" });
	}

	openAgentDetail(ctx: ExtensionContext, agentId: string) {
		if (this.opened) {
			this.close();
		}
		this.open(ctx, { mode: "detail", agentId });
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
		this.opened = false;
	}

	private open(ctx: ExtensionContext, nextOpen: { mode?: ViewMode; agentId?: string | null } = {}) {
		if (!ctx.hasUI || this.opened) return;
		this.nextOpen = nextOpen;
		this.opened = true;
		ctx.ui.custom(
			(tui, theme, _kb, done) =>
				new AgentLiveViewComponent({
					registry: this.registry,
					client: this.client,
					theme,
					initialMode: this.nextOpen?.mode,
					initialAgentId: this.nextOpen?.agentId ?? null,
					done: () => {
						this.opened = false;
						this.handle = null;
						this.nextOpen = null;
						if (this.ticker) {
							clearInterval(this.ticker);
							this.ticker = null;
						}
						done(null);
					},
					requestRender: () => tui.requestRender(),
				}) as any,
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "82%",
					minWidth: 76,
					maxHeight: "86%",
					margin: 1,
				},
				onHandle: (handle: any) => {
					this.handle = handle;
				},
			},
		);
		if (!this.ticker) {
			this.ticker = setInterval(() => this.requestRender(), 1000);
		}
	}
}
