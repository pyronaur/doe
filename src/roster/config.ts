import type { ICConfig, ICRole, SeatRole } from "./types.ts";

export const IC_ROLES = [
	"researcher",
	"senior",
	"mid",
	"junior",
	"intern",
] as const satisfies readonly ICRole[];
export const SEAT_ROLES = [...IC_ROLES, "contractor"] as const satisfies readonly SeatRole[];

export const SEAT_ROLE_LABELS: Record<SeatRole, string> = {
	researcher: "Researchers",
	senior: "Senior Developers",
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
		name: "Pattern",
		role: "researcher",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Khriss",
		role: "researcher",
		defaults: {
			model: "gpt-5.4",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Jarvis",
		role: "senior",
		defaults: {
			model: "gpt-5.3-codex",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Stark",
		role: "senior",
		defaults: {
			model: "gpt-5.3-codex",
			effort: "high",
			allowWrite: true,
		},
	},
	{
		name: "Shadow",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		name: "Echo",
		role: "mid",
		defaults: {
			model: "gpt-5.4",
			effort: "medium",
			allowWrite: true,
		},
	},
	{
		name: "Dash",
		role: "junior",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Flash",
		role: "junior",
		defaults: {
			model: "gpt-5.4-mini",
			effort: "medium",
			allowWrite: false,
		},
	},
	{
		name: "Spark",
		role: "intern",
		defaults: {
			model: "gpt-5.3-codex-spark",
			effort: "low",
			allowWrite: false,
		},
	},
] as const satisfies readonly ICConfig[];
