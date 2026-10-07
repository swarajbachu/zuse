import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CloudGithubCredentialRequest,
	CloudGitIdentity,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	GitExecutionEnvironment,
	GitExecutionResolver,
} from "../provider/services/runtime-git-execution.ts";

const TurnIdentity = Schema.fromJsonString(
	Schema.Struct({
		actor: CloudGithubCredentialRequest.fields.actor,
		githubSlackMessageId: Schema.optional(Schema.String),
	}),
);
const Credential = Schema.Struct({
	token: Schema.NonEmptyString,
	expiresAtMs: Schema.Number,
	identity: CloudGitIdentity,
});

/** Each immutable identity gets separate files and child-process environment. */
export const prepareGitExecution = async (input: {
	readonly nativeRepositoryPath?: string;
	readonly directory: string;
	readonly authHelperPath: string;
	readonly key: string;
	readonly context: typeof CloudGithubCredentialRequest.Type;
	readonly credentialUrl: string;
	readonly credential: string;
}): Promise<GitExecutionEnvironment> => {
	const helper = await readFile(input.authHelperPath, "utf8");
	if (!helper.includes("ZUSE_GITHUB_CONTEXT_DIR"))
		throw new Error(
			"Restart this cloud workspace to update its GitHub authentication helper.",
		);
	const response = await fetch(input.credentialUrl, {
		method: "POST",
		signal: AbortSignal.timeout(20_000),
		headers: {
			authorization: `Bearer ${input.credential}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(input.context),
	});
	if (!response.ok)
		throw new Error(
			response.status === 403
				? "GitHub authentication required. Connect your own GitHub account in Cloud settings."
				: "GitHub access could not be verified. Retry after checking your GitHub connection.",
		);
	const value = Schema.decodeUnknownSync(Credential)(await response.json());
	if (!Number.isFinite(value.expiresAtMs) || value.expiresAtMs <= Date.now())
		throw new Error("GitHub credential has expired.");
	const directory = join(input.directory, "github-executions", input.key);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const shellQuote = (value: string) =>
		"'" + value.replaceAll("'", "'\"'\"'") + "'";
	await writeFile(
		join(directory, "gh"),
		`#!/bin/sh\nexec /bin/bash ${shellQuote(input.authHelperPath)} gh "$@"\n`,
		{ mode: 0o700 },
	);
	for (const [name, contents] of Object.entries({
		"request.json": JSON.stringify(input.context),
		"github-installation-token": value.token,
		"github-installation-token-expires-at": String(value.expiresAtMs),
	})) {
		const target = join(directory, name);
		const next = `${target}.${randomUUID()}.next`;
		await writeFile(next, contents, { mode: 0o600 });
		await rename(next, target);
	}
	return {
		key: input.key,
		context: input.context,
		env: {
			ZUSE_GITHUB_CONTEXT_DIR: directory,
			PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			GIT_CONFIG_COUNT: input.nativeRepositoryPath === undefined ? "2" : "4",
			...(input.nativeRepositoryPath === undefined
				? {}
				: {
						GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
						GIT_CONFIG_VALUE_2: "git@github.com:",
						GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
						GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
					}),
			GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
			GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
			GIT_CONFIG_VALUE_1: `/bin/bash ${shellQuote(input.authHelperPath)} credential`,
			GIT_AUTHOR_NAME: value.identity.name,
			GIT_AUTHOR_EMAIL: value.identity.email,
			GIT_COMMITTER_NAME: value.identity.name,
			GIT_COMMITTER_EMAIL: value.identity.email,
		},
	};
};

export const makeCloudGitExecution = (input: {
	readonly preferNativeGit?: boolean;
	readonly nativeRepositoryPath?: string;
	readonly sql: SqlClient.SqlClient;
	readonly directory: string;
	readonly authHelperPath: string;
	readonly credentialUrl: string;
	readonly credential: () => string;
	readonly initialSessionId: string;
	readonly initialTurnId?: string;
	readonly initialContext?: typeof CloudGithubCredentialRequest.Type;
}): GitExecutionResolver => {
	const cached = new Map<string, Promise<GitExecutionEnvironment>>();
	let nativeCheck:
		| { until: number; pending: ReturnType<typeof checkNativeGitAccess> }
		| undefined;

	return async (sessionId) => {
		if (
			input.nativeRepositoryPath !== undefined &&
			input.preferNativeGit !== false
		) {
			if (!nativeCheck || nativeCheck.until < Date.now())
				nativeCheck = {
					until: Date.now() + 15_000,
					pending: checkNativeGitAccess(input.nativeRepositoryPath),
				};
			const access = await nativeCheck.pending;
			if (access === "readable")
				return { key: "snapshot-native", context: {}, env: {} };
			if (access === "unavailable")
				throw new Error(
					"Snapshot Git access could not be checked. Check the network and retry; native credentials were preserved.",
				);
			throw new Error(
				"Authentication required: sign in to GitHub on this workspace, or connect GitHub in Cloud settings and select Use my Zuse GitHub connection for a new workspace.",
			);
		}
		const rows = await Effect.runPromise(input.sql<{
			turn_id: string;
			input_json: string;
		}>`
			SELECT json_extract(e.payload_json, '$.turnId') AS turn_id,
				json_extract(e.payload_json, '$.providerInputJson') AS input_json
			FROM events e JOIN sessions s ON s.id = e.stream_id
			WHERE e.stream_kind = 'session' AND e.stream_id = ${sessionId}
				AND e.type = 'ProviderTurnRequested'
				AND (s.current_turn_id IS NULL OR json_extract(e.payload_json, '$.turnId') = s.current_turn_id)
			ORDER BY e.stream_version DESC LIMIT 1
		`);
		const row = rows[0];
		const turn =
			row === undefined
				? undefined
				: Schema.decodeUnknownSync(TurnIdentity)(row.input_json);
		const context =
			turn?.actor !== undefined || turn?.githubSlackMessageId !== undefined
				? { actor: turn.actor, slackMessageId: turn.githubSlackMessageId }
				: sessionId === input.initialSessionId &&
						row?.turn_id === input.initialTurnId
					? (input.initialContext ?? {})
					: {};
		const key = createHash("sha256")
			.update(JSON.stringify({ sessionId, context }))
			.digest("hex");
		const existing = cached.get(key);
		if (existing !== undefined) return existing;
		const pending = prepareGitExecution({
			...input,
			key,
			context,
			credential: input.credential(),
		});
		cached.set(key, pending);
		try {
			return await pending;
		} catch (error) {
			cached.delete(key);
			throw error;
		}
	};
};

/** A read-only check proves read access, never push permission. */
export const checkNativeGitAccess = (
	cwd: string,
): Promise<"readable" | "authentication-required" | "unavailable"> =>
	new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, "ls-remote", "origin", "HEAD"],
			{
				timeout: 8000,
				maxBuffer: 16384,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GCM_INTERACTIVE: "never",
					SSH_ASKPASS_REQUIRE: "never",
				},
			},
			(error, _stdout, stderr) =>
				resolve(
					!error
						? "readable"
						: /Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(
									stderr,
								)
							? "authentication-required"
							: "unavailable",
				),
		);
	});
