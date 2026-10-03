import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { CloudWorkspaceOpError } from "./cloud-workspaces.ts";
import { GithubRepoSummary } from "./workspace.ts";

export class CloudGithubInstallation extends Schema.Class<CloudGithubInstallation>(
	"CloudGithubInstallation",
)({
	installationId: Schema.Number,
	accountLogin: Schema.String,
	accountType: Schema.Literals(["User", "Organization"]),
	avatarUrl: Schema.optional(Schema.String),
	repositorySelection: Schema.Literals(["all", "selected"]),
	suspended: Schema.Boolean,
}) {}

export const CloudGitIdentity = Schema.Struct({
	name: Schema.String,
	email: Schema.String,
});

export class CloudGithubStatus extends Schema.Class<CloudGithubStatus>(
	"CloudGithubStatus",
)({
	configured: Schema.Boolean,
	user: Schema.optional(
		Schema.Struct({
			login: Schema.String,
			name: Schema.String,
			email: Schema.String,
		}),
	),
	installations: Schema.Array(CloudGithubInstallation),
	repositories: Schema.Array(GithubRepoSummary),
}) {}

export const CloudGithubStatusRpc = Rpc.make("cloud.github.status", {
	payload: Schema.Void,
	success: CloudGithubStatus,
	error: CloudWorkspaceOpError,
});

export const CloudGithubInstallResult = Schema.Struct({
	url: Schema.String,
});

export const CloudGithubInstallRpc = Rpc.make("cloud.github.install", {
	payload: Schema.Void,
	success: CloudGithubInstallResult,
	error: CloudWorkspaceOpError,
});

export const CloudGithubDisconnectRpc = Rpc.make("cloud.github.disconnect", {
	payload: Schema.Struct({ installationId: Schema.Number }),
	success: Schema.Struct({ ok: Schema.Boolean }),
	error: CloudWorkspaceOpError,
});
