import type { GitReviewScope } from "@zuse/contracts";

export type MobileReviewScope = GitReviewScope | "last_turn";

export const REVIEW_SCOPES: readonly MobileReviewScope[] = [
	"unstaged",
	"staged",
	"branch",
	"last_turn",
];

export const reviewScopeLabel = (scope: MobileReviewScope): string => {
	switch (scope) {
		case "unstaged":
			return "Unstaged";
		case "staged":
			return "Staged";
		case "branch":
			return "Branch";
		case "last_turn":
			return "Last turn";
	}
};
