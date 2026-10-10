import { Effect, Schema } from "effect";
import { ApiError, serviceUnavailable } from "./errors.ts";
import { githubRequest } from "./github-transport.ts";

const Membership = Schema.Struct({ role: Schema.String, state: Schema.String });
const Repositories = Schema.Struct({
	repositories: Schema.Array(
		Schema.Struct({
			full_name: Schema.String,
			permissions: Schema.optional(Schema.Struct({ push: Schema.Boolean })),
		}),
	),
});

export type GithubLinkAccess =
	| { readonly kind: "owner" }
	| { readonly kind: "member"; readonly repositories: readonly string[] }
	| { readonly kind: "approval-required" }
	| { readonly kind: "denied" };

/** GitHub owner approval grants the app access. A member can share only the
 * writable repositories GitHub exposes to their own user token. */
export const githubLinkAccess = Effect.fn("githubLinkAccess")(function* (
	installation: {
		readonly id: number;
		readonly account: {
			readonly id: number;
			readonly login: string;
			readonly type: string;
		};
	},
	userId: number,
	userToken: string,
): Effect.fn.Return<GithubLinkAccess, ApiError> {
	if (installation.account.type === "User")
		return { kind: installation.account.id === userId ? "owner" : "denied" };
	if (installation.account.type !== "Organization") return { kind: "denied" };
	const membership = yield* githubRequest<unknown>(
		`https://api.github.com/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`,
		userToken,
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Membership)),
		Effect.mapError((error) =>
			error instanceof ApiError
				? error
				: serviceUnavailable("github_membership_invalid"),
		),
		Effect.catch((error) =>
			error.detail === "github_403"
				? Effect.succeed("approval-required" as const)
				: error.detail === "github_404"
					? Effect.succeed(null)
					: Effect.fail(error),
		),
	);
	if (membership === "approval-required") return { kind: "approval-required" };
	if (membership?.state !== "active") return { kind: "denied" };
	if (membership.role === "admin") return { kind: "owner" };
	if (membership.role !== "member") return { kind: "denied" };
	const repositories = new Set<string>();
	// GitHub limits a repository-scoped installation token to 500 repos.
	for (let page = 1; page <= 5; page++) {
		const result = yield* githubRequest<unknown>(
			`https://api.github.com/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
			userToken,
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Repositories)),
			Effect.mapError((error) =>
				error instanceof ApiError
					? error
					: serviceUnavailable("github_repositories_invalid"),
			),
		);
		for (const repository of result.repositories) {
			const [owner, name, extra] = repository.full_name.split("/");
			if (
				repository.permissions?.push === true &&
				owner?.toLowerCase() === installation.account.login.toLowerCase() &&
				name &&
				/^[\w.-]+$/u.test(name) &&
				extra === undefined
			)
				repositories.add(repository.full_name);
		}
		if (result.repositories.length < 100) break;
	}
	return repositories.size === 0
		? { kind: "denied" }
		: { kind: "member", repositories: [...repositories] };
});

export const githubLinkAllowsRepository = (
	allowedRepositories: readonly string[] | undefined,
	repository: string,
) =>
	allowedRepositories === undefined ||
	allowedRepositories.some(
		(allowed) => allowed.toLowerCase() === repository.toLowerCase(),
	);
