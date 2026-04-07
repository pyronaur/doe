import type { ICRole, ICConfig, SeatRole } from "./types.js";

export const IC_ROLES = ["researcher", "senior", "mid", "junior", "intern"] as const satisfies readonly ICRole[];
export const SEAT_ROLES = [...IC_ROLES, "contractor"] as const satisfies readonly SeatRole[];

export const SEAT_ROLE_LABELS: Record<SeatRole, string> = {
	researcher: "Researchers",
	senior: "Senior Engineers",
	mid: "Mid-level Engineers",
	junior: "Junior Engineers",
	intern: "Interns",
	contractor: "Contractors",
};

/**
 * Built-in IC configurations.
 * Ordered for roster display and first-available assignment preference.
 */
export const IC_CONFIG = [
	{
		name: "Tony",
		role: "researcher",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Bruce",
		role: "researcher",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Strange",
		role: "senior",
		defaults: {
			model: "gpt-5.3-codex",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Peter",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		name: "Sam",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		name: "Scott",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		name: "Jane",
		role: "junior",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Pepper",
		role: "junior",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Hope",
		role: "intern",
		defaults: {
			model: "gpt-5.3-codex-spark",
			effort: "low",
			allowWrite: false,
		},
	},
] as const satisfies readonly ICConfig[];
