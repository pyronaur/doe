import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CodexAppServerClient } from "../codex/app-server-client.ts";
import type { DoeRegistry } from "../roster/registry.ts";
import { AgentLiveViewComponent } from "./agent-live-view.ts";

type ViewMode = "list" | "detail";

interface OpenState {
	mode?: ViewMode;
	agentId?: string | null;
}

interface LiveViewHandle {
	requestRender?: () => void;
	close?: () => void;
}

function isLiveViewHandle(value: unknown): value is LiveViewHandle {
	return Boolean(value) && typeof value === "object";
}

export class AgentLiveViewController {
	private handle: LiveViewHandle | null = null;
	private opened = false;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private nextOpen: OpenState | null = null;
	private readonly registry: DoeRegistry;
	private readonly client: CodexAppServerClient;

	constructor(registry: DoeRegistry, client: CodexAppServerClient) {
		this.registry = registry;
		this.client = client;
	}

	toggle(ctx: ExtensionContext, nextOpen: OpenState = {}) {
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
		const handle = this.handle;
		if (!handle?.requestRender) {
			return;
		}
		handle.requestRender();
	}

	close() {
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
		const handle = this.handle;
		if (handle?.close) {
			handle.close();
		}
		this.handle = null;
		this.opened = false;
	}

	private onViewDone(done: (value?: unknown) => void, value?: unknown) {
		this.opened = false;
		this.handle = null;
		this.nextOpen = null;
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
		done(value);
	}

	private open(ctx: ExtensionContext, nextOpen: OpenState = {}) {
		if (!ctx.hasUI || this.opened) {
			return;
		}
		this.nextOpen = nextOpen;
		this.opened = true;
		ctx.ui.custom(
			(tui, ...rest) => {
				const [theme, _kb, done] = rest;
				return new AgentLiveViewComponent({
					registry: this.registry,
					client: this.client,
					theme,
					initialMode: this.nextOpen?.mode,
					initialAgentId: this.nextOpen?.agentId ?? null,
					done: (value) => this.onViewDone(done, value),
					requestRender: () => tui.requestRender(),
				});
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "82%",
					minWidth: 76,
					maxHeight: "86%",
					margin: 1,
				},
				onHandle: (handle: unknown) => {
					this.handle = isLiveViewHandle(handle) ? handle : null;
				},
			},
		);
		if (!this.ticker) {
			this.ticker = setInterval(() => this.requestRender(), 1000);
		}
	}
}
