import type { ICConfig, ICRole, SeatRole } from "./types.ts";

export const IC_ROLES = [
	"senior",
	"mid",
	"researcher",
] as const satisfies readonly ICRole[];
export const SEAT_ROLES = [...IC_ROLES, "contractor"] as const satisfies readonly SeatRole[];

export const SEAT_ROLE_LABELS: Record<SeatRole, string> = {
	researcher: "Researchers",
	senior: "Seniors",
	mid: "Mid-level Engineers",
	contractor: "Contractors",
};

/**
 * Built-in IC configurations.
 * Ordered for roster display and first-available assignment preference.
 * Fixed 3x3 grouping: Seniors, Mid-level, Researchers/Assistants.
 */
export const IC_CONFIG = [
	{
		name: "Tony",
		role: "senior",
		defaults: {
			model: "gpt-5.3-codex",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Bruce",
		role: "senior",
		defaults: {
			model: "gpt-5.3-codex",
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
		name: "Hope",
		role: "researcher",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Jane",
		role: "researcher",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Pepper",
		role: "researcher",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
] as const satisfies readonly ICConfig[];
