import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dispatchPlannotatorRequest } from "../src/plan/plannotator-request.ts";

test("dispatchPlannotatorRequest does not fan out one request to stale duplicate listeners", async () => {
	const bus = new EventEmitter();
	let launches = 0;
	for (let i = 0; i < 3; i += 1) {
		bus.on("plannotator:request", (request) => {
			launches += 1;
			(request as any).respond({ status: "handled", result: { reviewId: `review-${i}` } });
		});
	}

	await new Promise<void>((resolve) => {
		dispatchPlannotatorRequest(bus as any, "plannotator:request", {
			requestId: "req-1",
			action: "plan-review",
			payload: { planContent: "# plan" },
			respond: () => resolve(),
		});
	});

	assert.equal(launches, 1);
});

test("dispatchPlannotatorRequest falls back to emit when listener introspection is unavailable", async () => {
	let launches = 0;
	const bus = {
		emit(_eventName: string, request: unknown) {
			launches += 1;
			(request as any).respond({ status: "handled" });
			return true;
		},
	};

	await new Promise<void>((resolve) => {
		dispatchPlannotatorRequest(bus, "plannotator:request", {
			requestId: "req-2",
			action: "plan-review",
			payload: { planContent: "# plan" },
			respond: () => resolve(),
		});
	});

	assert.equal(launches, 1);
});
