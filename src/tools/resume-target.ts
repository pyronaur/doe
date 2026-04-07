import type { DoeRegistry } from "../roster/registry.ts";

interface ResolveSeatTargetOptions {
	includeFinished?: boolean;
	missingSeatMessage?: ((ic: string) => string) | null;
}

export function resolveSeatTarget(
	registry: DoeRegistry,
	params: any,
	options: ResolveSeatTargetOptions = {},
) {
	const includeFinished = options.includeFinished ?? false;
	const missingSeatMessage = options.missingSeatMessage ?? null;
	if (params.ic) {
		const active = registry.findActiveSeatAgent(params.ic);
		if (active) {
			return active;
		}
		if (includeFinished) {
			const finished = registry.findLastFinishedSeatAgent(params.ic);
			if (finished) {
				return finished;
			}
		}
		if (missingSeatMessage && registry.findSeat(params.ic)) {
			throw new Error(missingSeatMessage(params.ic));
		}
	}
	if (params.agentId) {
		return registry.findAgent(params.agentId);
	}
	if (params.threadId) {
		return registry.findAgent(params.threadId);
	}
	return undefined;
}

export function resolveResumeTarget(registry: DoeRegistry, params: any) {
	return resolveSeatTarget(registry, params, {
		includeFinished: params.reuseFinished === true,
		missingSeatMessage: (ic) =>
			`No active assignment is attached to ${ic}. Use codex_spawn for fresh work on that seat, or set reuseFinished=true to reopen the last finished context.`,
	});
}
