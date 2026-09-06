/**
 * "Create from…" for a cloud workspace means choosing which ref the sandbox
 * checks out, never a local worktree. The API accepts a `branch` (the
 * workspace's own branch) and a `baseRef` it is reset to; the sandbox image
 * only carries refs that exist under `origin`, so the mapping refuses
 * anything that could not be there.
 */
export type CloudLaunchSourceSelection =
	| Readonly<{
			kind: "pr";
			number: number;
			headRefName: string;
			isCrossRepository: boolean;
	  }>
	| Readonly<{ kind: "branch"; branch: string; remote: string | null }>
	| Readonly<{ kind: "issue" }>
	| Readonly<{ kind: "linear" }>;

export type CloudLaunchRef = Readonly<{
	baseRef: string;
	branch?: string;
}>;

export type CloudLaunchRequestResult =
	| Readonly<{ ok: true; ref: CloudLaunchRef }>
	| Readonly<{ ok: false; message: string }>;

/** Mirrors the control plane's `invalid_git_ref` validation for branch names. */
const CLOUD_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/u;

const invalidBranch = (branch: string): CloudLaunchRequestResult => ({
	ok: false,
	message: `Branch "${branch}" contains characters the cloud workspace can't use.`,
});

export const cloudLaunchRequestForSource = (
	selection: CloudLaunchSourceSelection | null,
	defaultBranch: string,
): CloudLaunchRequestResult => {
	if (
		selection === null ||
		selection.kind === "issue" ||
		selection.kind === "linear"
	)
		return { ok: true, ref: { baseRef: `origin/${defaultBranch}` } };
	if (selection.kind === "pr") {
		if (selection.isCrossRepository)
			return {
				ok: false,
				message: `PR #${selection.number} comes from a fork. PRs from forks can't start in the cloud yet.`,
			};
		if (selection.headRefName.length === 0)
			return {
				ok: false,
				message: `PR #${selection.number} has no head branch to check out.`,
			};
		if (!CLOUD_BRANCH_NAME.test(selection.headRefName))
			return invalidBranch(selection.headRefName);
		return {
			ok: true,
			ref: {
				branch: selection.headRefName,
				baseRef: `origin/${selection.headRefName}`,
			},
		};
	}
	if (selection.remote === null)
		return {
			ok: false,
			message: `Push "${selection.branch}" to origin before starting it in the cloud.`,
		};
	if (!CLOUD_BRANCH_NAME.test(selection.branch))
		return invalidBranch(selection.branch);
	return {
		ok: true,
		ref: {
			branch: selection.branch,
			baseRef: `origin/${selection.branch}`,
		},
	};
};
