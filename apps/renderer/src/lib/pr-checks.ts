import type { GitPrCheckRun } from "@zuse/contracts";
export type CheckKind = "failure" | "pending" | "success" | "neutral";

export const checkKind = (check: GitPrCheckRun): CheckKind => {
	if (check.status !== "completed") return "pending";
	switch (check.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "cancelled":
		case "timed_out":
		case "action_required":
			return "failure";
		default:
			return "neutral";
	}
};
