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

/** Prepare an immutable actor context without performing a credential/API read. */
export const prepareGitExecutionContext = async (input: {
	readonly directory: string;
	readonly authHelperPath: string;
	readonly key: string;
	readonly context: typeof CloudGithubCredentialRequest.Type;
}) => {
	const helper = await readFile(input.authHelperPath, "utf8");
	if (!helper.includes("ZUSE_GITHUB_CONTEXT_DIR"))
		throw new Error(
			"Restart this cloud workspace to update its GitHub authentication helper.",
		);
	const directory = join(input.directory, "github-executions", input.key);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
	await writeFile(
		join(directory, "gh"),
		`#!/bin/sh\nexec /bin/bash ${shellQuote(input.authHelperPath)} gh "$@"\n`,
		{ mode: 0o700 },
	);

	await writeFile(
		join(directory, "request.json"),
		JSON.stringify(input.context),
		{ mode: 0o600, flag: "wx" },
	).catch(async (error: NodeJS.ErrnoException) => {
		if (
			error.code !== "EEXIST" ||
			(await readFile(join(directory, "request.json"), "utf8")) !==
				JSON.stringify(input.context)
		)
			throw error;
	});
	return {
		directory,
		env: {
			ZUSE_GITHUB_CONTEXT_DIR: directory,
			PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
			GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
			GIT_CONFIG_VALUE_1: `/bin/bash ${shellQuote(input.authHelperPath)} credential`,
		},
	};
};

/** Each immutable identity gets separate files and child-process environment. */
export const prepareGitExecution = async (input: {
	readonly directory: string;
	readonly authHelperPath: string;
	readonly key: string;
	readonly context: typeof CloudGithubCredentialRequest.Type;
	readonly credentialUrl: string;
	readonly credential: string;
}): Promise<GitExecutionEnvironment> => {
	const execution = await prepareGitExecutionContext(input);
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
	const directory = execution.directory;
	for (const [name, contents] of Object.entries({
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
			...execution.env,
			GIT_AUTHOR_NAME: value.identity.name,
			GIT_AUTHOR_EMAIL: value.identity.email,
			GIT_COMMITTER_NAME: value.identity.name,
			GIT_COMMITTER_EMAIL: value.identity.email,
		},
	};
};

export const makeCloudGitExecution = (input: {
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
	return async (sessionId) => {
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
