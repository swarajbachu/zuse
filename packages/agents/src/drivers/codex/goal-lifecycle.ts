import type { ThreadGoalStatus } from "@zuse/contracts";
import type { TurnStatus } from "./generated/v2/TurnStatus.ts";
/** Native goal status, rather than each autonomous native turn, owns goal completion. */
export const makeCodexGoalLifecycle = () => {
	let owned = false;
	let active = false;
	let physicalTurn = false;
	return {
		start: () => {
			owned = true;
			active = true;
		},
		turnStarted: () => {
			physicalTurn = true;
		},
		turnCompleted: (status: TurnStatus) => {
			physicalTurn = false;
			if (status === "failed" || status === "interrupted") active = false;
			return !owned || !active;
		},
		updated: (status: ThreadGoalStatus) => {
			active = status === "active";
			return owned && !active && !physicalTurn;
		},
		cleared: () => {
			active = false;
			return owned && !physicalTurn;
		},
	};
};
