import type { ICRole, ICConfig, SeatRole } from "./types.js";

export const IC_ROLES = ["senior", "mid", "research"] as const satisfies readonly ICRole[];
export const SEAT_ROLES = [...IC_ROLES, "contractor"] as const satisfies readonly SeatRole[];

export const SEAT_ROLE_LABELS: Record<SeatRole, string> = {
	senior: "Senior Engineers",
	mid: "Mid-level Engineers",
	research: "Researchers/Assistants",
	contractor: "Contractors",
};

/**
 * Built-in IC configurations.
 * Ordered for roster display and first-available assignment preference.
 */
export const IC_CONFIG = [
	{
		slug: "tony",
		name: "Tony",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		slug: "bruce",
		name: "Bruce",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		slug: "strange",
		name: "Strange",
		role: "senior",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		slug: "peter",
		name: "Peter",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		slug: "sam",
		name: "Sam",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		slug: "scott",
		name: "Scott",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		slug: "hope",
		name: "Hope",
		role: "research",
		defaults: {
			model: "gpt-5.3-codex-spark",
			effort: "low",
			allowWrite: false,
		},
	},
	{
		slug: "jane",
		name: "Jane",
		role: "research",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "high",
			allowWrite: false,
		},
	},
	{
		slug: "pepper",
		name: "Pepper",
		role: "research",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "high",
			allowWrite: false,
		},
	},
] as const satisfies readonly ICConfig[];

