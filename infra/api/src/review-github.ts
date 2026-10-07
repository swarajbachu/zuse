import { ApiPaths } from "@zuse/contracts";
import { Effect, Option, Redacted, Schema } from "effect";
import { authenticateWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import { badRequest, forbidden, serviceUnavailable } from "./errors.ts";
import { githubAppRequest, githubRequest } from "./github-transport.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import {
	type ReviewAuthorization,
	ReviewStore,
	type VerifiedReviewRepository,
} from "./review-store.ts";
import { WorkosVerifier } from "./workos.ts";
import { resolveWorkspaceActorAccess } from "./workspace-authorization.ts";
import { workspaceScopeForOwner } from "./workspace-scope.ts";

export const REVIEW_OAUTH_PREFIX = "zuse-review-";
const cookieName = "__Host-zuse-review";
const headers = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
};
const Repository = Schema.Struct({
	id: Schema.Number,
	full_name: Schema.String,
	permissions: Schema.optional(
		Schema.Struct({
			pull: Schema.optional(Schema.Boolean),
			admin: Schema.optional(Schema.Boolean),
		}),
	),
});
/** The user's OAuth token is used only for fresh access proof; it is never persisted. */
export const verifyReviewRepository = Effect.fn("verifyReviewRepository")(
	function* (
		token: string,
		repositoryId: number,
	): Effect.fn.Return<
		VerifiedReviewRepository,
		import("./errors.ts").ApiError,
		ApiConfiguration
	> {
		const user = yield* githubRequest<unknown>(
			"https://api.github.com/user",
			token,
		).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Number })),
			),
			Effect.mapError(() => forbidden("review_github_identity_required")),
		);
		const repository = yield* githubRequest<unknown>(
			`https://api.github.com/repositories/${repositoryId}`,
			token,
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Repository)),
			Effect.mapError(() => forbidden("review_repository_access_required")),
		);
		if (
			repository.id !== repositoryId ||
			!Number.isSafeInteger(user.id) ||
			user.id <= 0 ||
			repository.permissions?.pull !== true
		)
			return yield* forbidden("review_repository_access_required");
		if (!/^[^/\s]+\/[^/\s]+$/.test(repository.full_name))
			return yield* badRequest("review_repository_invalid");
		const installation = yield* githubAppRequest<unknown>(
			`https://api.github.com/repos/${repository.full_name}/installation`,
		).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Struct({
						id: Schema.Number,
						suspended_at: Schema.NullOr(Schema.String),
					}),
				),
			),
			Effect.mapError(() => forbidden("review_installation_required")),
		);
		if (
			installation.suspended_at !== null ||
			!Number.isSafeInteger(installation.id) ||
			installation.id <= 0
		)
			return yield* forbidden("review_installation_required");
		// Minting for this explicit repository proves selected-repository installation access.
		yield* reviewInstallationToken(installation.id, repositoryId);
		return {
			githubUserId: user.id,
			repositoryId,
			repositoryFullName: repository.full_name,
			installationId: installation.id,
			admin: repository.permissions.admin === true,
		};
	},
);
export const reviewInstallationToken = Effect.fn("reviewInstallationToken")(
	function* (installationId: number, repositoryId: number) {
		return yield* githubAppRequest<{ token: string; expires_at: string }>(
			`https://api.github.com/app/installations/${installationId}/access_tokens`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					repository_ids: [repositoryId],
					permissions: {
						contents: "read",
						pull_requests: "read",
						metadata: "read",
					},
				}),
			},
		);
	},
);
export const reviewGithubCallback = Effect.fn("reviewGithubCallback")(
	function* (request: Request) {
		const url = new URL(request.url);
		const state = url.searchParams.get("state");
		if (!state?.startsWith(REVIEW_OAUTH_PREFIX)) return null;
		if (request.method !== "GET" || !/^zuse-review-[a-f0-9-]{36}$/.test(state))
			return yield* badRequest("review_invalid_authorization");
		const service = yield* Effect.serviceOption(ReviewStore);
		if (Option.isNone(service))
			return yield* serviceUnavailable("review_storage_unavailable");
		// OAuth redirects alone prove GitHub identity, not which Zuse actor initiated it.
		const verifier = yield* Effect.serviceOption(WorkosVerifier);
		if (Option.isNone(verifier))
			return yield* serviceUnavailable("review_browser_auth_unavailable");
		const browserActor = yield* authenticateWorkos(request).pipe(
			Effect.provideService(WorkosVerifier, verifier.value),
		);
		const config = yield* ApiConfiguration;
		const github = config.githubApp;
		if (!github?.clientId || !github.clientSecret)
			return yield* serviceUnavailable("github_app_oauth_not_configured");
		const clientSecret = Redacted.value(github.clientSecret);
		const nowMs = Date.now();
		const intent = yield* Effect.tryPromise({
			try: () => service.value.getAuthorization(state, nowMs),
			catch: () => serviceUnavailable("review_storage_unavailable"),
		});
		if (!intent) return yield* badRequest("review_authorization_expired");
		if (browserActor.accountId !== intent.actorId)
			return yield* forbidden("review_authorization_actor_mismatch");
		if (!getReviewReadiness(intent.request.agentProvider).available)
			return yield* serviceUnavailable("review_provider_verification_required");
		const callback = new URL(
			ApiPaths.cloudGithubCallback,
			config.publicApiOrigin ?? config.apiIssuer,
		).toString();
		const code = url.searchParams.get("code");
		if (!code) {
			if (url.searchParams.has("error"))
				return yield* badRequest("review_authorization_denied");
			const target = new URL("https://github.com/login/oauth/authorize");
			target.searchParams.set("client_id", github.clientId);
			target.searchParams.set("redirect_uri", callback);
			target.searchParams.set("state", state);
			return new Response(null, {
				status: 302,
				headers: {
					...headers,
					location: target.href,
					"set-cookie": `${cookieName}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
				},
			});
		}
		if (
			!(request.headers.get("cookie") ?? "")
				.split(";")
				.some((v) => v.trim() === `${cookieName}=${state}`)
		)
			return yield* badRequest("review_invalid_browser_state");
		yield* resolveWorkspaceActorAccess(
			{ accountId: intent.actorId, orgId: undefined },
			workspaceScopeForOwner(intent.ownerId),
			"administration",
		);
		const token = yield* Effect.tryPromise({
			try: async () => {
				const response = await fetch(
					"https://github.com/login/oauth/access_token",
					{
						method: "POST",
						redirect: "error",
						signal: AbortSignal.timeout(30000),
						headers: {
							accept: "application/json",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							client_id: github.clientId,
							client_secret: clientSecret,
							code,
							redirect_uri: callback,
						}),
					},
				);
				if (!response.ok) throw new Error("oauth_failed");
				return Schema.decodeUnknownSync(
					Schema.Struct({ access_token: Schema.String }),
				)(await response.json());
			},
			catch: () => badRequest("review_authorization_failed"),
		});
		const proof = yield* verifyReviewRepository(
			token.access_token,
			intent.request.repositoryId,
		);
		yield* Effect.tryPromise({
			try: () => service.value.completeAuthorization(state, proof, Date.now()),
			catch: () => badRequest("review_enrollment_conflict"),
		});
		return new Response("GitHub repository verified. Return to Zuse Review.", {
			headers: {
				...headers,
				"content-type": "text/plain; charset=utf-8",
				"set-cookie": `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
			},
		});
	},
);
export const reviewAuthorizationUrl = (
	intent: ReviewAuthorization,
	origin: string,
) => {
	const target = new URL(ApiPaths.cloudGithubCallback, origin);
	target.searchParams.set("state", intent.id);
	return target.href;
};
