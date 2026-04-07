import type { AgentActivity } from "../codex/client.ts";
import { type CurrentContextUsage, deriveUsageSnapshot } from "../context-usage.ts";
import { DoeRegistryBase } from "./registry-base.ts";
import {
	cloneAgent,
	cloneMessage,
	createCompactionState,
	latestAgentSummary,
	mergeHydratedMessages,
	normalizeErrorText,
	shouldIgnoreInterruptedTerminalUpdate,
	tailSnippet,
	TERMINAL_STATES,
} from "./registry-helpers.ts";
import type { AgentMessageRecord, AgentRecord } from "./types.ts";

function readMessageUpdate(agent: AgentRecord, itemId: string): {
	nextMessages: AgentMessageRecord[];
	index: number;
} {
	const nextMessages = [...agent.messages];
	const index = nextMessages.findIndex((message) => message.itemId === itemId);
	return { nextMessages, index };
}

function applyMessageSummary(
	agent: AgentRecord,
	nextMessages: AgentMessageRecord[],
	options: { keepFinalOutput?: boolean } = {},
): AgentRecord {
	const summary = latestAgentSummary(nextMessages);
	const latestFinalOutput = options.keepFinalOutput
		? summary?.latestFinalOutput ?? agent.latestFinalOutput ?? null
		: summary?.latestFinalOutput ?? null;
	return {
		...agent,
		messages: nextMessages,
		latestSnippet: summary?.latestSnippet ?? agent.latestSnippet,
		latestFinalOutput,
	};
}

function buildErrorAgent(agent: AgentRecord, normalizedError: string): AgentRecord {
	return {
		...agent,
		state: "error" as const,
		activityLabel: "error" as const,
		completedAt: Date.now(),
		activeTurnId: null,
		interruptedTurnId: null,
		lastError: normalizedError,
		latestSnippet: tailSnippet(normalizedError),
	};
}

function removeWaiter<T>(map: Map<string, T[]>, key: string, waiter: T) {
	map.set(
		key,
		(map.get(key) ?? []).filter((entry) => entry !== waiter),
	);
}

export class DoeRegistryRuntime extends DoeRegistryBase {
	markThreadAttached(
		agentId: string,
		details: { threadId: string; activeTurnId?: string | null; recovered?: boolean },
	) {
		this.updateAgent(agentId, (agent) => ({
			...agent,
			threadId: details.threadId,
			activeTurnId: details.activeTurnId ?? agent.activeTurnId ?? null,
			recovered: details.recovered ?? false,
		}));
	}

	markThreadStatus(
		threadId: string,
		status: { type?: string; activeFlags?: string[] } | null | undefined,
	) {
		if (!status) {
			return;
		}
		this.updateAgentByThread(threadId, (agent) => {
			let state = agent.state;
			let activityLabel = agent.activityLabel ?? null;
			if (status.type === "active") {
				const waiting = (status.activeFlags ?? []).includes("waitingOnApproval");
				state = waiting ? "awaiting_input" : "working";
				activityLabel = waiting ? "awaiting approval" : activityLabel;
				return { ...agent, state, activityLabel };
			}
			if (status.type === "systemError") {
				state = "error";
				activityLabel = "error";
				return { ...agent, state, activityLabel };
			}
			return { ...agent, state, activityLabel };
		});
	}

	markTurnStarted(threadId: string, turnId: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			activeTurnId: turnId,
			interruptedTurnId: null,
			state: "working",
			activityLabel: "thinking",
			runStartedAt: agent.runStartedAt ?? agent.startedAt,
			completedAt: null,
		}));
	}

	markActivity(threadId: string, activityLabel: AgentActivity) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: activityLabel === "awaiting input" || activityLabel === "awaiting approval"
				? "awaiting_input"
				: agent.state,
			activityLabel,
		}));
	}

	appendAgentDelta(threadId: string, delta: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			latestSnippet: tailSnippet(`${agent.latestSnippet}${delta}`),
		}));
	}

	markTokenUsage(threadId: string, turnId: string | null, usage: CurrentContextUsage) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			usage: deriveUsageSnapshot(usage, turnId),
			recovered: false,
		}));
	}

	markCompactionStarted(
		threadId: string,
		details: { turnId?: string | null; itemId?: string | null },
	) {
		this.updateAgentByThread(threadId, (agent) => {
			const compaction = createCompactionState(agent.compaction);
			return {
				...agent,
				compaction: {
					...compaction,
					inProgress: true,
					lastStartedAt: Date.now(),
					lastTurnId: details.turnId ?? compaction.lastTurnId ?? null,
					lastItemId: details.itemId ?? null,
					lastSignal: "contextCompaction",
				},
			};
		});
	}

	markCompactionCompleted(
		threadId: string,
		details: {
			turnId?: string | null;
			itemId?: string | null;
			source: "contextCompaction" | "thread/compacted";
		},
	) {
		this.updateAgentByThread(threadId, (agent) => {
			const compaction = createCompactionState(agent.compaction);
			const sameTurn = compaction.lastCompletedAt !== null
				&& compaction.lastTurnId === (details.turnId ?? null);
			return {
				...agent,
				compaction: {
					...compaction,
					inProgress: false,
					count: sameTurn ? compaction.count : compaction.count + 1,
					lastCompletedAt: Date.now(),
					lastTurnId: details.turnId ?? compaction.lastTurnId ?? null,
					lastItemId: details.itemId ?? compaction.lastItemId ?? null,
					lastSignal: details.source,
				},
			};
		});
	}

	appendUserMessage(agentId: string, turnId: string, text: string) {
		this.updateAgent(agentId, (agent) => {
			const nextMessages = [
				...agent.messages,
				{
					turnId,
					itemId: null,
					role: "user",
					text,
					streaming: false,
					createdAt: Date.now(),
					completedAt: Date.now(),
				} satisfies AgentMessageRecord,
			];
			return { ...agent, messages: nextMessages };
		});
	}

	appendAgentMessageDelta(
		input: { threadId: string; turnId: string; itemId: string; delta: string },
	) {
		this.updateAgentByThread(input.threadId, (agent) => {
			const { nextMessages, index } = readMessageUpdate(agent, input.itemId);
			if (index < 0) {
				nextMessages.push({
					turnId: input.turnId,
					itemId: input.itemId,
					role: "agent",
					text: input.delta,
					streaming: true,
					createdAt: Date.now(),
					completedAt: null,
				});
				return applyMessageSummary(agent, nextMessages);
			}
			const current = nextMessages[index];
			nextMessages[index] = {
				...current,
				turnId: input.turnId,
				text: `${current.text}${input.delta}`,
				streaming: true,
				completedAt: null,
			};
			return applyMessageSummary(agent, nextMessages);
		});
	}

	completeAgentMessage(input: { threadId: string; turnId: string; itemId: string; text: string }) {
		this.updateAgentByThread(input.threadId, (agent) => {
			const { nextMessages, index } = readMessageUpdate(agent, input.itemId);
			const completedAt = Date.now();
			if (index < 0) {
				nextMessages.push({
					turnId: input.turnId,
					itemId: input.itemId,
					role: "agent",
					text: input.text,
					streaming: false,
					createdAt: completedAt,
					completedAt,
				});
				return applyMessageSummary(agent, nextMessages, { keepFinalOutput: true });
			}
			nextMessages[index] = {
				...nextMessages[index],
				turnId: input.turnId,
				text: input.text,
				streaming: false,
				completedAt,
			};
			return applyMessageSummary(agent, nextMessages, { keepFinalOutput: true });
		});
	}

	hydrateAgentMessages(agentId: string, messages: AgentMessageRecord[]) {
		this.updateAgent(agentId, (agent) => {
			const nextMessages = mergeHydratedMessages(agent.messages, messages);
			const summary = latestAgentSummary(nextMessages);
			return {
				...agent,
				messages: nextMessages,
				historyHydratedAt: Date.now(),
				latestSnippet: summary?.latestSnippet ?? agent.latestSnippet,
				latestFinalOutput: summary?.latestFinalOutput ?? agent.latestFinalOutput ?? null,
			};
		});
	}

	getAgentMessages(agentId: string): AgentMessageRecord[] {
		return (this.agents.get(agentId)?.messages ?? []).map(cloneMessage);
	}

	setAgentSnippet(threadId: string, text: string) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			latestSnippet: tailSnippet(text),
			latestFinalOutput: text,
		}));
	}

	markCompleted(threadId: string, turnIdOrOutput?: string | null, finalOutput?: string | null) {
		const turnId = finalOutput === undefined ? null : (turnIdOrOutput ?? null);
		const outputOverride = finalOutput === undefined ? (turnIdOrOutput ?? null) : finalOutput;
		this.updateAgentByThread(threadId, (agent) => {
			if (shouldIgnoreInterruptedTerminalUpdate(agent, turnId)) {
				return agent;
			}
			const summary = latestAgentSummary(agent.messages);
			const output = outputOverride ?? summary?.latestFinalOutput ?? agent.latestFinalOutput
				?? agent.latestSnippet;
			return {
				...agent,
				state: "completed" as const,
				activityLabel: "completed" as const,
				completedAt: Date.now(),
				activeTurnId: null,
				interruptedTurnId: null,
				latestFinalOutput: output,
				latestSnippet: output ? tailSnippet(output) : agent.latestSnippet,
			};
		});
	}

	markAwaitingInput(threadId: string, note?: string | null) {
		this.updateAgentByThread(threadId, (agent) => ({
			...agent,
			state: "awaiting_input",
			activityLabel: "awaiting input",
			completedAt: Date.now(),
			activeTurnId: null,
			interruptedTurnId: null,
			latestSnippet: note ? tailSnippet(note) : agent.latestSnippet,
		}));
	}

	markError(threadId: string, error: string, turnId?: string | null) {
		const normalizedError = normalizeErrorText(error);
		this.updateAgentByThread(threadId, (agent) => {
			if (shouldIgnoreInterruptedTerminalUpdate(agent, turnId)) {
				return agent;
			}
			return buildErrorAgent(agent, normalizedError);
		});
	}

	markAgentError(agentId: string, error: string) {
		const normalizedError = normalizeErrorText(error);
		this.updateAgent(agentId, (agent) => buildErrorAgent(agent, normalizedError));
	}

	markCompletionNotified(agentId: string) {
		this.updateAgent(agentId, (agent) => ({ ...agent, completionNotified: true }));
	}

	markBatchNotified(batchId: string) {
		const batch = this.batches.get(batchId);
		if (!batch) {
			return;
		}
		this.batches.set(batch.id, { ...batch, notified: true });
		this.emitChange();
	}

	waitForAgent(agentId: string, signal?: AbortSignal): Promise<AgentRecord> {
		const existing = this.agents.get(agentId);
		if (existing && TERMINAL_STATES.has(existing.state)) {
			return Promise.resolve(cloneAgent(existing));
		}
		return new Promise<AgentRecord>((resolve, reject) => {
			const waiter = (agent: AgentRecord) => resolve(cloneAgent(agent));
			const current = this.agentWaiters.get(agentId) ?? [];
			current.push(waiter);
			this.agentWaiters.set(agentId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentAgent = this.agents.get(agentId);
					if (currentAgent && TERMINAL_STATES.has(currentAgent.state)) {
						resolve(cloneAgent(currentAgent));
						return;
					}
					removeWaiter(this.agentWaiters, agentId, waiter);
					reject(new Error("Cancelled"));
				},
				{ once: true },
			);
		});
	}

	waitForBatch(batchId: string, signal?: AbortSignal): Promise<AgentRecord[]> {
		const batch = this.batches.get(batchId);
		if (!batch) {
			return Promise.resolve([]);
		}
		const currentAgents = batch.agentIds
			.map((id) => this.agents.get(id))
			.filter((agent): agent is AgentRecord => agent !== undefined);
		if (
			currentAgents.length > 0 && currentAgents.every((agent) => TERMINAL_STATES.has(agent.state))
		) {
			return Promise.resolve(currentAgents.map(cloneAgent));
		}
		return new Promise<AgentRecord[]>((resolve, reject) => {
			const waiter = (agents: AgentRecord[]) => resolve(agents.map(cloneAgent));
			const current = this.batchWaiters.get(batchId) ?? [];
			current.push(waiter);
			this.batchWaiters.set(batchId, current);
			signal?.addEventListener(
				"abort",
				() => {
					const currentBatch = this.batches.get(batchId);
					const currentBatchAgents = (currentBatch?.agentIds ?? [])
						.map((id) => this.agents.get(id))
						.filter((agent): agent is AgentRecord => agent !== undefined);
					if (
						currentBatchAgents.length > 0
						&& currentBatchAgents.every((agent) => TERMINAL_STATES.has(agent.state))
					) {
						resolve(currentBatchAgents.map(cloneAgent));
						return;
					}
					removeWaiter(this.batchWaiters, batchId, waiter);
					reject(new Error("Cancelled"));
				},
				{ once: true },
			);
		});
	}
}
