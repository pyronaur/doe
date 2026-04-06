export interface PlannotatorRequestEnvelope<R> {
	requestId: string;
	action: string;
	payload: Record<string, unknown>;
	respond: (response: R) => void;
}

export function dispatchPlannotatorRequest<R>(
	eventBus: {
		emit: (eventName: string, payload: unknown) => boolean;
		listeners?: (eventName: string) => Array<(payload: unknown) => unknown>;
	},
	channel: string,
	request: PlannotatorRequestEnvelope<R>,
): void {
	const listeners = typeof eventBus.listeners === "function"
		? eventBus.listeners(channel).filter((listener) => typeof listener === "function")
		: [];
	if (listeners.length > 0) {
		const latestListener = listeners[listeners.length - 1]!;
		void latestListener(request);
		return;
	}
	eventBus.emit(channel, request);
}
