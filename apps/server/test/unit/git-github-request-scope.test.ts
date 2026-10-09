import { ChatId, FolderId } from "@zuse/contracts";
import { GitHubRequestScope } from "@zuse/git/github-client";
import { Effect, Stream } from "effect";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../src/api/cloud-git-execution.ts", () => ({
	prepareGitExecutionContext: vi.fn(async ({ key }) => ({
		env: { ZUSE_GITHUB_CONTEXT_DIR: key },
	})),
}));

import { prepareGitExecutionContext } from "../../src/api/cloud-git-execution.ts";
import {
	withGitHubActor,
	withGitHubActorStream,
} from "../../src/git/github-request-scope.ts";
import { ConnectionIdentity } from "../../src/lan-auth/services/connection-identity.ts";

const identity = (subject: string) => ({
	kind: "workspace" as const,
	subject,
	membershipId: `membership-${subject}`,
	workspaceId: "workspace",
	chatId: ChatId.make("chat"),
	projectId: FolderId.make("project"),
	expiresAt: Date.now() + 60_000,
	authorize: Effect.succeed("edit" as const),
});
afterEach(() => vi.unstubAllEnvs());

test("authenticated actors get independent immutable API and native Git scopes", async () => {
	vi.stubEnv("ZUSE_USER_DATA", "/actor-scope-test");
	const first = await Effect.runPromise(
		withGitHubActor(
			Effect.gen(function* () {
				return yield* GitHubRequestScope;
			}),
		).pipe(Effect.provideService(ConnectionIdentity, identity("a"))),
	);
	const second = await Effect.runPromise(
		withGitHubActor(
			Effect.gen(function* () {
				return yield* GitHubRequestScope;
			}),
		).pipe(Effect.provideService(ConnectionIdentity, identity("b"))),
	);
	expect(first?.key).not.toBe(second?.key);
	expect(JSON.parse(first?.body ?? "{}")).toEqual({
		actor: { subject: "a", membershipId: "membership-a" },
	});
	expect((await first?.resolveEnv?.())?.ZUSE_GITHUB_CONTEXT_DIR).not.toBe(
		(await second?.resolveEnv?.())?.ZUSE_GITHUB_CONTEXT_DIR,
	);
	expect(prepareGitExecutionContext).toHaveBeenCalledTimes(2);
	const stream = withGitHubActorStream(
		Stream.fromEffect(
			Effect.gen(function* () {
				return yield* GitHubRequestScope;
			}),
		),
	);
	const values = await Effect.runPromise(
		Stream.runCollect(stream).pipe(
			Effect.provideService(ConnectionIdentity, identity("b")),
		),
	);
	expect(values).toEqual([second]);
});

test("desktop requests retain desktop credential authority", async () => {
	const scope = await Effect.runPromise(
		withGitHubActor(
			Effect.gen(function* () {
				return yield* GitHubRequestScope;
			}),
		),
	);
	expect(scope).toBeNull();
});
