export type OpenPrWorkflow = {
	kind: "open-pr";
	number: number | null;
	url: string | null;
	isDraft: boolean;
	checks: "none" | "pending" | "success" | "failure";
	mergeable: "clean" | "conflicting" | "unknown";
	checksTotal: number;
	checksRunning: number;
	checksPassing: number;
	checksFailing: number;
	autoMergeEnabled: boolean;
};

export type BranchWorkflow =
	| { kind: "idle" }
	| { kind: "dirty"; count: number }
	| { kind: "ahead"; count: number }
	| { kind: "merged-pr" }
	| { kind: "ready-for-pr" }
	| OpenPrWorkflow;

export const resolveBranchLabel = (
	statusBranch: string | null,
	worktreeBranch: string | null,
	cloudBranch: string | null,
): { readonly label: string | null; readonly cached: boolean } => ({
	label: statusBranch ?? worktreeBranch ?? cloudBranch,
	cached:
		statusBranch === null && (worktreeBranch !== null || cloudBranch !== null),
});

type WorkflowStatus = {
	branch: string | null;
	dirtyFiles: number;
	ahead: number;
};

export type WorkflowPr = {
	state: string;
	number: number | null;
	url: string | null;
	isDraft?: boolean;
	checks?: "none" | "pending" | "success" | "failure";
	mergeable?: "clean" | "conflicting" | "unknown";
	checksTotal?: number;
	checksRunning?: number;
	checksPassing?: number;
	checksFailing?: number;
	autoMergeEnabled?: boolean;
};

export const deriveBranchWorkflow = (
	status: WorkflowStatus | null,
	pr: WorkflowPr | null,
	canCreatePrWhenSynced: boolean,
): BranchWorkflow => {
	const prOpen = pr !== null && pr.state === "open";
	const prKnownNotOpen = pr !== null && !prOpen;
	if (status === null) return { kind: "idle" };
	if (status.dirtyFiles > 0) return { kind: "dirty", count: status.dirtyFiles };
	if (status.ahead > 0) return { kind: "ahead", count: status.ahead };
	if (pr !== null && prOpen) {
		return {
			kind: "open-pr",
			number: pr.number,
			url: pr.url,
			isDraft: pr.isDraft === true,
			checks: pr.checks ?? "none",
			mergeable: pr.mergeable ?? "unknown",
			checksTotal: pr.checksTotal ?? 0,
			checksRunning: pr.checksRunning ?? 0,
			checksPassing: pr.checksPassing ?? 0,
			checksFailing: pr.checksFailing ?? 0,
			autoMergeEnabled: pr.autoMergeEnabled === true,
		};
	}
	if (pr?.state === "merged") return { kind: "merged-pr" };
	if (canCreatePrWhenSynced && prKnownNotOpen) return { kind: "ready-for-pr" };
	return { kind: "idle" };
};

type WorkflowContext =
	| { status: "loading" | "empty" }
	| {
			status: "ready";
			worktreePending: boolean;
			rootKind: "worktree" | "folder";
	  };

export const canCreatePrFromSyncedBranch = (
	status: Pick<WorkflowStatus, "branch"> | null,
	ctx: WorkflowContext,
): boolean => {
	if (ctx.status !== "ready" || ctx.worktreePending) return false;
	if (ctx.rootKind === "worktree") return true;
	const branch = status?.branch ?? null;
	return branch !== null && branch !== "main" && branch !== "master";
};

export type EnvironmentChecksRow = {
	kind: "pending" | "failure" | "success";
	label: string;
	canFix: boolean;
};

export const deriveEnvironmentPrRows = (
	pr: WorkflowPr | null,
): {
	checks: EnvironmentChecksRow | null;
	conflicts: boolean;
} => {
	if (pr === null || pr.state !== "open") {
		return { checks: null, conflicts: false };
	}

	const checksTotal = pr.checksTotal ?? 0;
	const checksRunning = pr.checksRunning ?? 0;
	const checksFailing = pr.checksFailing ?? 0;
	let checks: EnvironmentChecksRow | null = null;

	if (checksTotal > 0) {
		if (checksFailing > 0) {
			checks = {
				kind: "failure",
				label: `${checksFailing} check${checksFailing === 1 ? "" : "s"} failing`,
				canFix: true,
			};
		} else if (checksRunning > 0) {
			checks = {
				kind: "pending",
				label: `${checksRunning} check${checksRunning === 1 ? "" : "s"} running`,
				canFix: false,
			};
		} else {
			checks = { kind: "success", label: "Checks passed", canFix: false };
		}
	}

	return {
		checks,
		conflicts: pr.mergeable === "conflicting",
	};
};
