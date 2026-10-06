import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { layer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, test, vi } from "vitest";
import {
	makeCloudGitExecution,
	prepareGitExecution,
} from "../../src/api/cloud-git-execution.ts";
import { makeRuntimeGitExecution } from "../../src/provider/services/runtime-git-execution.ts";

const authHelperPath = fileURLToPath(
	new URL("../../../../infra/cloud-sandboxes/github-auth.sh", import.meta.url),
);
afterEach(() => vi.unstubAllGlobals());

test("concurrent member and Slack runs commit and authenticate with isolated identities", async () => {
	const directory = await mkdtemp(join(tmpdir(), "git-execution-"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			const context = JSON.parse(init.body);
			const name = context.slackMessageId ? "zuse[bot]" : context.actor.subject;
			return Response.json({
				token: `token-${name}`,
				expiresAtMs: Date.now() + 3_600_000,
				identity: { name, email: `${name}@example.test` },
			});
		}),
	);
	try {
		const contexts = [
			{ actor: { subject: "alice", membershipId: "a" } },
			{ actor: { subject: "bob", membershipId: "b" } },
			{ slackMessageId: "slack-1" },
		];
		const executions = await Promise.all(
			contexts.map((context, index) =>
				prepareGitExecution({
					directory,
					authHelperPath,
					key: String(index),
					context,
					credentialUrl: "https://api.test/token",
					credential: "runtime",
				}),
			),
		);
		for (const [index, execution] of executions.entries()) {
			const env = {
				...process.env,
				...execution.env,
				GIT_CONFIG_GLOBAL: join(directory, "empty.config"),
				GIT_CONFIG_NOSYSTEM: "1",
				ZUSE_GITHUB_TOKEN_FILE: "",
				ZUSE_USER_DATA: directory,
			};
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: directory,
					env,
					encoding: "utf8",
				}).trim();
			if (index === 0) git("init", "-q");
			git("commit", "--allow-empty", "-qm", "identity test");
			const name = ["alice", "bob", "zuse[bot]"][index];
			expect(git("log", "-1", "--format=%an|%cn")).toBe(`${name}|${name}`);
			const credential = execFileSync("git", ["credential", "fill"], {
				cwd: directory,
				env,
				encoding: "utf8",
				input: "protocol=https\nhost=github.com\n\n",
			});
			expect(credential).toContain(`password=token-${name}`);
			await writeFile(
				join(directory, "fake-gh"),
				'#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n',
				{ mode: 0o700 },
			);
			expect(
				execFileSync(
					join(
						execution.env.ZUSE_GITHUB_CONTEXT_DIR ?? "missing-context",
						"gh",
					),
					["api", "user"],
					{
						env: { ...env, ZUSE_GH_BINARY: join(directory, "fake-gh") },
						encoding: "utf8",
					},
				),
			).toBe(`token-${name}`);
			expect(
				JSON.parse(
					await readFile(
						join(
							execution.env.ZUSE_GITHUB_CONTEXT_DIR ?? "missing-context",
							"request.json",
						),
						"utf8",
					),
				),
			).toEqual(contexts[index]);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("durable turn actors survive restart and changing actors cannot reuse another credential cache", async () => {
	const directory = await mkdtemp(join(tmpdir(), "git-actors-"));
	const runtime = ManagedRuntime.make(
		layer({ filename: join(directory, "db.sqlite") }),
	);
	const fetch = vi.fn(async (_url, init) => {
		const { actor } = JSON.parse(init.body);
		return Response.json({
			token: actor.subject,
			expiresAtMs: Date.now() + 3_600_000,
			identity: { name: actor.subject, email: `${actor.subject}@example.test` },
		});
	});
	vi.stubGlobal("fetch", fetch);
	try {
		const sql = await runtime.runPromise(SqlClient.SqlClient);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* sql`CREATE TABLE sessions(id TEXT, current_turn_id TEXT)`;
				yield* sql`CREATE TABLE events(stream_kind TEXT, stream_id TEXT, type TEXT, payload_json TEXT, stream_version INTEGER)`;
				yield* sql`INSERT INTO sessions VALUES ('s', 'turn-a')`;
				for (const [version, name] of [
					[1, "alice"],
					[2, "bob"],
				] as const)
					yield* sql`INSERT INTO events VALUES ('session','s','ProviderTurnRequested',${JSON.stringify({ turnId: version === 1 ? "turn-a" : "turn-b", providerInputJson: JSON.stringify({ actor: { subject: name, membershipId: name } }) })},${version})`;
			}),
		);
		const options = {
			sql,
			directory,
			authHelperPath,
			credentialUrl: "https://api.test/token",
			credential: () => "runtime",
			initialSessionId: "s",
		};
		const resolve = makeCloudGitExecution(options);
		const alice = await resolve("s");
		expect((await resolve("s"))?.key).toBe(alice?.key);
		expect(fetch).toHaveBeenCalledTimes(1);
		await runtime.runPromise(sql`UPDATE sessions SET current_turn_id='turn-b'`);
		const bob = await resolve("s");
		expect(bob?.key).not.toBe(alice?.key);
		expect(bob?.env.GIT_AUTHOR_NAME).toBe("bob");
		expect(
			(await makeCloudGitExecution(options)("s"))?.env.GIT_AUTHOR_NAME,
		).toBe("bob");
	} finally {
		await runtime.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cloud startup waits for its resolver and fails closed after disposal", async () => {
	const service = makeRuntimeGitExecution(true);
	let resolved = false;
	const pending = service.resolve("session").then(() => {
		resolved = true;
	});
	await Promise.resolve();
	expect(resolved).toBe(false);
	const dispose = service.install(async () => undefined);
	await pending;
	expect(resolved).toBe(true);
	dispose();
	await expect(service.resolve("session")).rejects.toThrow(
		"Cloud GitHub execution is unavailable",
	);
	expect(
		await makeRuntimeGitExecution().resolve("local-session"),
	).toBeUndefined();
});
