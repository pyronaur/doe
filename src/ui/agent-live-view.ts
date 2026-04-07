import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import { extractThreadTranscript, truncateForDisplay } from "../codex/client.ts";
import { formatUsageBreakdown } from "../context-usage.ts";
import { SEAT_ROLE_LABELS, SEAT_ROLES } from "../roster/config.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import type { AgentRecord } from "../roster/types.ts";
import { formatAgentProgressLine } from "./agent-progress.ts";

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

function wrapText(text: string, width: number): string[] {
	if (width <= 0) { return [""]; }
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
	if (!value) { return "n/a"; }
	return new Date(value).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function listViewportSize(): number {
	const rows = process.stdout.rows ?? 32;
	return Math.max(8, Math.min(18, rows - 10));
}

function detailViewportSize(): number {
	return 12;
}

export class AgentLiveViewComponent {
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
		return this.registry.listRosterAssignments().map((entry) => entry.agent);
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
		if (!this.selectedAgentId) { return null; }
		return agents.find((agent) => agent.id === this.selectedAgentId) ?? null;
	}

	private moveSelection(delta: number) {
		const agents = this.ensureSelection();
		if (agents.length === 0) { return; }
		const currentIndex = Math.max(0,
			agents.findIndex((agent) => agent.id === this.selectedAgentId));
		const nextIndex = Math.max(0, Math.min(agents.length - 1, currentIndex + delta));
		this.selectedAgentId = agents[nextIndex].id;
		this.requestRender();
	}

	private moveSelectionTo(index: number) {
		const agents = this.ensureSelection();
		if (agents.length === 0) { return; }
		const nextIndex = Math.max(0, Math.min(agents.length - 1, index));
		this.selectedAgentId = agents[nextIndex].id;
		this.requestRender();
	}

	private openDetail() {
		const agents = this.ensureSelection();
		const agent = this.selectedAgent(agents);
		if (!agent) { return; }
		this.mode = "detail";
		this.detailAgentId = agent.id;
		this.detailScrollTop = null;
		this.hydrationError = null;
		void this.ensureHistory(agent);
		this.requestRender();
	}

	private async ensureHistory(agent: AgentRecord) {
		if (!agent.threadId) { return; }
		if (agent.historyHydratedAt) { return; }
		if (this.hydratingAgentId === agent.id) { return; }
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
		if (!agent) { return; }
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

		const step = matchesKey(data, "pageup")
			? -8
			: matchesKey(data, "pagedown")
			? 8
			: matchesKey(data, Key.up) || data === "k"
			? -1
			: matchesKey(data, Key.down) || data === "j"
			? 1
			: 0;
		if (step === 0) { return; }
		this.scrollDetail(step);
	}

	private scrollDetail(delta: number) {
		const agent = this.detailAgentId ? this.registry.getAgent(this.detailAgentId) : null;
		if (!agent) { return; }
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
		const trimmedTitle = titleText.length > titleWidth
			? `${titleText.slice(0, titleWidth - 1)}…`
			: titleText;
		const sideWidth = Math.max(0, inner - trimmedTitle.length);
		const left = Math.floor(sideWidth / 2);
		const right = sideWidth - left;
		const top = this.theme.fg("border", `╭${"─".repeat(left)}${trimmedTitle}${"─".repeat(right)}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(inner)}╯`);
		const lines = [top];
		for (const line of body) {
			const content = truncateToWidth(line, inner);
			const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
			lines.push(
				`${this.theme.fg("border", "│")}${content}${padding}${this.theme.fg("border", "│")}`,
			);
		}
		lines.push(bottom);
		return lines;
	}

	private renderEmptyList(width: number): string[] {
		const body: string[] = [
			this.theme.fg("dim", " No occupied ICs"),
			this.theme.fg("dim", " Use codex_spawn to delegate work"),
		];
		return this.renderFrame("DoE Occupied Roster", width, body);
	}

	private resolveListPage(
		agents: AgentRecord[],
	): { selectedId: string | null; pageStart: number; page: AgentRecord[] } {
		const selectedId = this.selectedAgentId;
		const selectedIndex = Math.max(0, agents.findIndex((agent) => agent.id === selectedId));
		const pageSize = listViewportSize();
		const pageStart = Math.max(0, Math.min(selectedIndex, Math.max(0, agents.length - pageSize)));
		return {
			selectedId,
			pageStart,
			page: agents.slice(pageStart, pageStart + pageSize),
		};
	}

	private pushRoleSummaryLines(body: string[], summaries: any[]) {
		for (const role of SEAT_ROLES) {
			const summary = summaries.find((entry) => entry.role === role);
			if (!summary || summary.activeCount === 0) {
				continue;
			}
			body.push(this.theme.fg("muted", ` ${SEAT_ROLE_LABELS[role]}: ${summary.names.join(", ")}`));
		}
	}

	private pushListAgentLines(input: {
		body: string[];
		agents: AgentRecord[];
		page: AgentRecord[];
		pageStart: number;
		selectedId: string | null;
		inner: number;
	}) {
		for (const [offset, agent] of input.page.entries()) {
			const absoluteIndex = input.pageStart + offset;
			const selected = agent.id === input.selectedId;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const title = truncateToWidth(`${absoluteIndex + 1}. ${agent.name}`, input.inner - 2);
			const meta = truncateToWidth(
				formatAgentProgressLine(agent, { includeName: false }),
				input.inner - 2,
			);
			const preview = truncateToWidth(
				truncateForDisplay(agent.latestFinalOutput ?? agent.latestSnippet, input.inner - 6)
					|| "(no transcript yet)",
				input.inner - 2,
			);
			input.body.push(`${marker} ${selected ? this.theme.fg("accent", title) : title}`);
			input.body.push(
				`  ${selected ? this.theme.fg("warning", meta) : this.theme.fg("muted", meta)}`,
			);
			input.body.push(`  ${this.theme.fg("dim", preview)}`);
			if (absoluteIndex < input.agents.length - 1) {
				input.body.push(this.theme.fg("border", "─".repeat(Math.max(0, input.inner - 1))));
			}
		}
	}

	private renderList(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const agents = this.ensureSelection();
		if (agents.length === 0) {
			return this.renderEmptyList(width);
		}
		const { selectedId, pageStart, page } = this.resolveListPage(agents);
		const summaries = this.registry.getRosterRoleSummaries();
		const body: string[] = [];
		body.push(this.theme.fg("accent", ` Occupied ICs ${agents.length}`));
		this.pushRoleSummaryLines(body, summaries);
		body.push(this.theme.fg("muted", " Up/Down move | Enter detail | Esc close"));
		body.push("");
		this.pushListAgentLines({ body, agents, page, pageStart, selectedId, inner });
		return this.renderFrame("DoE Occupied Roster", width, body);
	}

	private buildDetailBodyLines(agent: AgentRecord, width: number): string[] {
		const lines: string[] = [];
		const messages = agent.messages.length > 0
			? agent.messages
			: this.registry.getAgentMessages(agent.id);
		const messageWidth = Math.max(16, width - 4);

		if (this.hydratingAgentId === agent.id) {
			lines.push(this.theme.fg("warning", " Hydrating history from thread/read..."));
			lines.push("");
		}
		if (this.hydrationError && this.hydratingAgentId !== agent.id) {
			lines.push(
				this.theme.fg("error",
					` History hydration failed: ${truncateForDisplay(this.hydrationError, width - 4)}`),
			);
			lines.push("");
		}

		if (messages.length === 0) {
			lines.push(this.theme.fg("dim", " No captured conversation history yet."));
			return lines;
		}

		for (const message of messages) {
			const label = message.role === "user" ? "USER" : "AGENT";
			const suffix = message.streaming ? " • streaming" : "";
			lines.push(
				this.theme.fg(message.role === "user" ? "accent" : "success", ` ${label}${suffix}`),
			);
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
		body.push(this.theme.fg("accent", ` ${agent.seatName ?? agent.name}`));
		body.push(` ${formatAgentProgressLine(agent)}`);
		body.push(` ${agent.model} | ${agent.allowWrite ? "write" : "read-only"}`);
		body.push(` cwd: ${truncateForDisplay(agent.cwd, inner - 6)}`);
		body.push(
			` started: ${formatTimestamp(agent.startedAt)} | completed: ${
				formatTimestamp(agent.completedAt ?? null)
			}`,
		);
		for (const line of formatUsageBreakdown(agent.usage, agent.compaction)) {
			body.push(` ${truncateForDisplay(line, inner - 4)}`);
		}
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
			body.push(
				this.theme.fg("muted",
					` ${Math.min(start + viewport, contentLines.length)}/${contentLines.length}`),
			);
		}

		return this.renderFrame("IC Detail", width, body);
	}
}
