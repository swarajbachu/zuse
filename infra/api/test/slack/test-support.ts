import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Cipher, Database } from "@zuse/slack/installations";
import { Effect, Redacted } from "effect";
import { openApiString, sealApiString } from "../../src/api-sealing.ts";
import { layer } from "../../src/config.ts";

// Same encryption implementation and SQL as production; SQLite is an isolated SQL fixture.
const config = layer({
	apiIssuer: "https://api.test",
	workosJwksUrl: "https://api.workos.com/sso/jwks/client_test",
	workosIssuer: "https://api.workos.com",
	mintPrivateKey: Redacted.make("unused"),
	mintPublicKey: "unused",
	cloudDataEncryptionKey: Redacted.make(
		"YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
	),
});
export const testCipher: Cipher = {
	seal: (context, value) =>
		Effect.runPromise(
			sealApiString(context, value).pipe(Effect.provide(config)),
		),
	open: (context, value) =>
		Effect.runPromise(
			openApiString(context, value).pipe(Effect.provide(config)),
		),
};
export const testDatabase = (): { binding: Database; sqlite: DatabaseSync } => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/migrations/0022_slack_integrations.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/migrations/0023_slack_members.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	return {
		sqlite,
		binding: {
			query: async <T extends Record<string, unknown>>(
				query: string,
				values: readonly (string | number | null)[] = [],
			) => {
				const ordered: (string | number | null)[] = [];
				const sql = query.replace(/\$(\d+)/gu, (_match, index: string) => {
					ordered.push(values[Number(index) - 1] ?? null);
					return "?";
				});
				return sqlite.prepare(sql).all(...ordered) as T[];
			},
		},
	};
};
