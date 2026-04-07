import type { AssignableRosterBucket } from "./state/registry.js";

export interface ICDefaults {
	model: string;
	effort?: "low" | "medium" | "high" | "xhigh";
	allowWrite?: boolean;
}

export interface IC {
	name: string;
	role: AssignableRosterBucket;
	defaults: ICDefaults;
}

/**
 * Built-in IC configurations.
 * Keyed by name slug. Roles: senior (GPT 5.4 high), mid (GPT 5.4 medium),
 * research (GPT 5.3 spark / GPT 5.4 mini).
 */
export const ICs: Record<string, IC> = {
	tony: {
		name: "Tony",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	bruce: {
		name: "Bruce",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	strange: {
		name: "Strange",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	peter: {
		name: "Peter",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	sam: {
		name: "Sam",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	scott: {
		name: "Scott",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	hope: {
		name: "Hope",
		role: "research",
		defaults: {
			model: "gpt-5.3-codex-spark",
			effort: "low",
			allowWrite: false,
		},
	},
	jane: {
		name: "Jane",
		role: "research",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "high",
			allowWrite: false,
		},
	},
	pepper: {
		name: "Pepper",
		role: "research",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "high",
			allowWrite: false,
		},
	},
} as const;
