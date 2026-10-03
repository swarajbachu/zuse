import { Effect } from "effect";
import { ApiError, serviceUnavailable } from "./errors.ts";
export const githubApiHeaders = {
	accept: "application/vnd.github+json",
	"user-agent": "Zuse-GitHub-App/1.0",
	"x-github-api-version": "2026-03-10",
} as const;
export const githubRequest = <A>(
	url: string,
	token: string,
	init?: RequestInit,
) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				...init,
				signal: init?.signal ?? AbortSignal.timeout(15_000),
				headers: {
					...githubApiHeaders,
					authorization: `Bearer ${token}`,
					...init?.headers,
				},
			});
			if (!response.ok) {
				console.warn("[cloud-github] GitHub API request rejected", {
					endpoint: new URL(url).pathname,
					status: response.status,
				});
				throw serviceUnavailable(
					"github_app_unavailable",
					`github_${response.status}`,
				);
			}
			return (await response.json()) as A;
		},
		catch: (error) =>
			error instanceof ApiError
				? error
				: serviceUnavailable("github_app_unavailable"),
	});
