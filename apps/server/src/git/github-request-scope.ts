import { createHash } from "node:crypto";
import { GitHubRequestScope, type GitHubScope } from "@zuse/git/github-client";
import { Effect, Stream } from "effect";
import { prepareGitExecutionContext } from "../api/cloud-git-execution.ts";
import { connectionWorkspaceActor } from "../lan-auth/services/connection-identity.ts";

const contexts = new Map<string, GitHubScope>();
const requestScope = connectionWorkspaceActor.pipe(
	Effect.map((actor) => {
		if (!actor) return null;
		const body = JSON.stringify({ actor });
		const directory = process.env.ZUSE_USER_DATA;
		const key = createHash("sha256")
			.update(`${directory ?? ""}\0${body}`)
			.digest("hex");
		const existing = contexts.get(key);
		if (existing) return existing;
		let environment: Promise<Readonly<Record<string, string>>> | undefined;
		const scope: GitHubScope = {
			key,
			body,
			resolveEnv: () => {
				if (!directory)
					return Promise.reject(
						new Error("Cloud GitHub execution is unavailable."),
					);
				environment ??= prepareGitExecutionContext({
					directory,
					authHelperPath: "/var/lib/zuse/project-build/github-auth.sh",
					key: `rpc-${key}`,
					context: { actor },
				})
					.then((execution) => execution.env)
					.catch((error) => {
						environment = undefined;
						throw error;
					});
				return environment;
			},
		};
		if (contexts.size >= 512)
			contexts.delete(contexts.keys().next().value ?? "");
		contexts.set(key, scope);
		return scope;
	}),
);

/** Authority comes from the authenticated transport identity, never an RPC payload. */
export const withGitHubActor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	requestScope.pipe(
		Effect.flatMap((scope) =>
			effect.pipe(Effect.provideService(GitHubRequestScope, scope)),
		),
	);
export const withGitHubActorStream = <A, E, R>(
	stream: Stream.Stream<A, E, R>,
) =>
	Stream.unwrap(
		requestScope.pipe(
			Effect.map((scope) =>
				stream.pipe(Stream.provideService(GitHubRequestScope, scope)),
			),
		),
	);
