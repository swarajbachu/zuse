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

export const reviewScopeCompatibilityError = (
	requested: GitReviewScope | undefined,
	actual: GitReviewScope,
): string | null =>
	requested !== undefined && requested !== "branch" && requested !== actual
		? "Restart or update the desktop app to review staged and unstaged changes separately."
		: null;

/** Omit the original branch range for compatibility with older desktops. */
export const reviewScopeRequestValue = (
	scope: GitReviewScope | undefined,
): GitReviewScope | undefined =>
	scope === undefined || scope === "branch" ? undefined : scope;
