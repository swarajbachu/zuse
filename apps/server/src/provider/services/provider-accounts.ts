import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type NativeAccountProvider,
	type ProviderAccount,
	ProviderAccountError,
} from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../../app-paths.ts";

type AccountRow = {
	id: string;
	provider_id: NativeAccountProvider;
	name: string;
	preferred: number;
};
const metadata = (row: AccountRow): ProviderAccount => ({
	id: row.id,
	providerId: row.provider_id,
	name: row.name,
	preferred: row.preferred === 1,
});

export const makeProviderAccounts = Effect.fn("ProviderAccounts.make")(
	function* (userData: string, available = true) {
		const sql = yield* SqlClient.SqlClient;
		const failed = () =>
			new ProviderAccountError({
				message: "Account storage is unavailable. Try again.",
			});
		const requireAvailable = () =>
			available
				? Effect.void
				: Effect.fail(
						new ProviderAccountError({
							message:
								"Additional CLI accounts are managed on local and SSH computers.",
						}),
					);
		const find = Effect.fn("ProviderAccounts.find")(function* (
			provider: NativeAccountProvider,
			id: string,
		) {
			const rows =
				yield* sql<AccountRow>`SELECT id,provider_id,name,preferred FROM provider_accounts WHERE id=${id} AND provider_id=${provider}`.pipe(
					Effect.mapError(failed),
				);
			if (!rows[0])
				return yield* new ProviderAccountError({
					message:
						"This account was removed. Choose another account for a new chat.",
				});
			return rows[0];
		});
		const home = Effect.fn("ProviderAccounts.home")(function* (
			provider: NativeAccountProvider,
			id: string,
		) {
			yield* requireAvailable();
			yield* find(provider, id);
			const path = join(userData, "provider-accounts", provider, id);
			yield* Effect.tryPromise({
				try: () => mkdir(path, { recursive: true, mode: 0o700 }),
				catch: failed,
			});
			return path;
		});
		return {
			list: Effect.fn("ProviderAccounts.list")(function* (
				provider: NativeAccountProvider,
			) {
				const rows =
					yield* sql<AccountRow>`SELECT id,provider_id,name,preferred FROM provider_accounts WHERE provider_id=${provider} ORDER BY created_at,id`.pipe(
						Effect.mapError(failed),
					);
				return { available, accounts: rows.map(metadata) };
			}),
			save: Effect.fn("ProviderAccounts.save")(function* (
				provider: NativeAccountProvider,
				name: string,
				existingId?: string,
			) {
				yield* requireAvailable();
				const trimmed = name.trim();
				if (!trimmed || trimmed.length > 80)
					return yield* new ProviderAccountError({
						message: "Enter an account name of 1–80 characters.",
					});
				const id = existingId ?? randomUUID();
				if (existingId) yield* find(provider, existingId);
				yield* (
					existingId
						? sql`UPDATE provider_accounts SET name=${trimmed} WHERE id=${id} AND provider_id=${provider}`
						: sql`INSERT INTO provider_accounts(id,provider_id,name,preferred,created_at) VALUES(${id},${provider},${trimmed},0,${Date.now()})`
				).pipe(Effect.mapError(failed));
				return metadata(yield* find(provider, id));
			}),
			preferred: Effect.fn("ProviderAccounts.preferred")(function* (
				provider: NativeAccountProvider,
				id: string | null,
			) {
				yield* requireAvailable();
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							if (id !== null) yield* find(provider, id);
							yield* sql`UPDATE provider_accounts SET preferred=0 WHERE provider_id=${provider}`;
							if (id !== null)
								yield* sql`UPDATE provider_accounts SET preferred=1 WHERE id=${id} AND provider_id=${provider}`;
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error instanceof ProviderAccountError ? error : failed(),
						),
					);
			}),
			remove: Effect.fn("ProviderAccounts.remove")(function* (
				provider: NativeAccountProvider,
				id: string,
			) {
				yield* requireAvailable();
				yield* find(provider, id);
				// Keep account homes and affinity tombstones: active processes and resumed
				// transcripts must never be reassigned to a different login.
				yield* sql`DELETE FROM provider_accounts WHERE id=${id} AND provider_id=${provider}`.pipe(
					Effect.mapError(failed),
				);
			}),
			home,
			selected: Effect.fn("ProviderAccounts.selected")(function* (
				provider: NativeAccountProvider,
			) {
				if (!available) return null;
				const rows =
					yield* sql<AccountRow>`SELECT id,provider_id,name,preferred FROM provider_accounts WHERE provider_id=${provider} AND preferred=1`.pipe(
						Effect.mapError(failed),
					);
				return rows[0]
					? { ...metadata(rows[0]), home: yield* home(provider, rows[0].id) }
					: null;
			}),
			resolve: Effect.fn("ProviderAccounts.resolve")(function* (
				provider: NativeAccountProvider,
				sessionId: string,
				resuming: boolean,
			) {
				if (!available) return null;
				const accountId = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							const bound = yield* sql<{
								account_id: string | null;
							}>`SELECT account_id FROM session_provider_accounts WHERE session_id=${sessionId} AND provider_id=${provider}`;
							if (bound[0]) return bound[0].account_id;
							// Native forks inherit their source account. Legacy resumes stay on the
							// default login rather than picking today's preferred account.
							const source = resuming
								? yield* sql<{
										account_id: string | null;
									}>`SELECT a.account_id FROM sessions s JOIN session_provider_accounts a ON a.session_id=s.forked_from_session_id AND a.provider_id=${provider} WHERE s.id=${sessionId}`
								: [];
							const preferred = !resuming
								? yield* sql<{
										id: string;
									}>`SELECT id FROM provider_accounts WHERE provider_id=${provider} AND preferred=1`
								: [];
							const selected =
								source[0]?.account_id ?? preferred[0]?.id ?? null;
							yield* sql`INSERT INTO session_provider_accounts(session_id,provider_id,account_id) SELECT id,${provider},${selected} FROM sessions WHERE id=${sessionId} ON CONFLICT(session_id,provider_id) DO NOTHING`;
							return selected;
						}),
					)
					.pipe(Effect.mapError(failed));
				return accountId === null
					? null
					: { id: accountId, home: yield* home(provider, accountId) };
			}),
		};
	},
);

export class ProviderAccounts extends Context.Service<
	ProviderAccounts,
	Effect.Success<ReturnType<typeof makeProviderAccounts>>
>()("zuse/ProviderAccounts") {}
export const providerAccountsLayer = (available: boolean) =>
	Layer.effect(
		ProviderAccounts,
		Effect.gen(function* () {
			const paths = yield* AppPaths;
			return yield* makeProviderAccounts(paths.userData, available);
		}),
	);
