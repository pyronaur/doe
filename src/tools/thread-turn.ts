import type {
	ApprovalPolicy,
	ReasoningEffort,
	SandboxMode,
} from "../codex/client.ts";
import { recordStartedTurn, type TurnRegistry } from "./turn-start.ts";

interface TurnStarter {
	resumeThread(options: {
		threadId: string;
		cwd?: string;
		model?: string;
		approvalPolicy?: ApprovalPolicy;
		allowWrite?: boolean;
		sandbox?: SandboxMode;
	}): Promise<any>;
	startTurn(options: {
		threadId: string;
		prompt: string;
		cwd: string;
		model: string;
		effort: ReasoningEffort;
		approvalPolicy: ApprovalPolicy;
		networkAccess: boolean;
		allowWrite: boolean;
		sandbox?: SandboxMode;
	}): Promise<any>;
}

export async function resumeThreadAndStartTurn(input: {
	client: TurnStarter;
	registry: TurnRegistry;
	agentId: string;
	threadId: string;
	prompt: string;
	cwd: string;
	model: string;
	effort: ReasoningEffort;
	approvalPolicy: ApprovalPolicy;
	networkAccess: boolean;
	allowWrite: boolean;
	sandbox?: SandboxMode;
}) {
	await input.client.resumeThread({
		threadId: input.threadId,
		cwd: input.cwd,
		model: input.model,
		approvalPolicy: input.approvalPolicy,
		allowWrite: input.allowWrite,
		sandbox: input.sandbox,
	});
	const turn = await input.client.startTurn({
		threadId: input.threadId,
		prompt: input.prompt,
		cwd: input.cwd,
		model: input.model,
		effort: input.effort,
		approvalPolicy: input.approvalPolicy,
		networkAccess: input.networkAccess,
		allowWrite: input.allowWrite,
		sandbox: input.sandbox,
	});
	recordStartedTurn(input.registry, {
		agentId: input.agentId,
		threadId: input.threadId,
		turnId: turn.turn.id,
		prompt: input.prompt,
	});
}

export async function steerActiveTurn(input: {
	client: {
		steerTurn(options: { threadId: string; expectedTurnId: string; prompt: string }): Promise<any>;
	};
	registry: { appendUserMessage(agentId: string, turnId: string, prompt: string): void };
	agent: { id: string; threadId: string; activeTurnId: string | null; state: string };
	prompt: string;
	onBeforeSteer?: () => void;
}): Promise<boolean> {
	if (!(input.agent.activeTurnId && input.agent.state === "working")) {
		return false;
	}
	input.onBeforeSteer?.();
	await input.client.steerTurn({
		threadId: input.agent.threadId,
		expectedTurnId: input.agent.activeTurnId,
		prompt: input.prompt,
	});
	input.registry.appendUserMessage(input.agent.id, input.agent.activeTurnId, input.prompt);
	return true;
}
