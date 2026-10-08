import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runtimeGitHubCredential } from "../../src/git/github-credentials.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
test("cloud API credentials retain the broker's immutable actor context and expiry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-github-credential-"));
	try {
		const context = join(directory, "context");
		await mkdir(context);
		await Promise.all([
			writeFile(
				join(directory, "github-broker.json"),
				JSON.stringify({ credentialUrl: "https://api.example.com/credential" }),
			),
			writeFile(
				join(directory, "cloud-runtime-credential"),
				"test-runtime-credential",
			),
			writeFile(
				join(context, "request.json"),
				JSON.stringify({
					actor: { subject: "user-1", membershipId: "membership-1" },
				}),
			),
		]);
		vi.stubEnv("ZUSE_USER_DATA", directory);
		vi.stubEnv("ZUSE_GITHUB_CONTEXT_DIR", context);
		const expiresAt = Date.now() + 60_000;
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						token: "scoped-test-token",
						expiresAtMs: expiresAt,
					}),
				),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(
			await runtimeGitHubCredential(
				"github.com",
				"/repo",
				new AbortController().signal,
			),
		).toEqual({ token: "scoped-test-token", expiresAt });
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({
				actor: { subject: "user-1", membershipId: "membership-1" },
			}),
		});
		const body = JSON.stringify({
			actor: { subject: "user-2", membershipId: "membership-2" },
		});
		await runtimeGitHubCredential(
			"github.com",
			"/repo",
			new AbortController().signal,
			{ key: "member-2", body },
		);
		expect(fetcher.mock.calls[1]?.[1]?.body).toBe(body);
		await expect(
			runtimeGitHubCredential(
				"enterprise.example.com",
				"/repo",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ kind: "access" });
		expect(fetcher).toHaveBeenCalledTimes(2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cloud broker denial never falls back to a broader environment token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-github-denied-"));
	try {
		await writeFile(
			join(directory, "github-broker.json"),
			JSON.stringify({ credentialUrl: "https://api.example.com/credential" }),
		);
		await writeFile(
			join(directory, "cloud-runtime-credential"),
			"test-runtime-credential",
		);
		vi.stubEnv("ZUSE_USER_DATA", directory);
		vi.stubEnv("ZUSE_GITHUB_CONTEXT_DIR", "");
		vi.stubEnv("GH_TOKEN", "broad-token-must-not-be-used");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 403 })),
		);
		await expect(
			runtimeGitHubCredential(
				"github.com",
				"/repo",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ kind: "authentication" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an authenticated actor never falls back to desktop tokens before cloud setup", async () => {
	vi.stubEnv("ZUSE_USER_DATA", "");
	vi.stubEnv("ZUSE_CLOUD_WORKSPACE_ID", "");
	vi.stubEnv("ZUSE_GITHUB_CONTEXT_DIR", "");
	vi.stubEnv("GH_TOKEN", "broad-token");
	await expect(
		runtimeGitHubCredential(
			"github.com",
			"/repo",
			new AbortController().signal,
			{ key: "actor", body: "{}" },
		),
	).rejects.toMatchObject({ kind: "authentication" });
});
