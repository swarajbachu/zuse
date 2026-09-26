import type { ExtensionServerContext } from "@zuse/extension-sdk";
import { Schema } from "effect";
import {
	Account,
	type AccountProfile,
	type QuotaResult,
	quotaRpc,
} from "./contracts.ts";
import { readAccountCredential } from "./credentials.ts";
import { fetchQuota, sources } from "./providers.ts";

export { readCredential } from "./credentials.ts";

export default function setup(e: ExtensionServerContext) {
	const cache = new Map<string, QuotaResult>();
	const lastAttempt = new Map<string, number>();
	const lifetime = new AbortController();
	let queue: Promise<unknown> = Promise.resolve();
	const accounts = async () =>
		Schema.decodeUnknownSync(Schema.Array(Account))(
			(await e.storage.get("accounts")) ?? [],
		);
	const result = (account: AccountProfile): QuotaResult =>
		cache.get(account.id) ?? {
			account,
			windows: [],
			fetchedAt: null,
			error: null,
			plan: null,
		};
	const refresh = async (
		account: AccountProfile,
		signal: AbortSignal,
		credential?: unknown,
	) => {
		if (Date.now() - (lastAttempt.get(account.id) ?? 0) < 60000) return;
		signal.throwIfAborted();
		lastAttempt.set(account.id, Date.now());
		try {
			const current =
				credential ?? (await readAccountCredential(account, signal));
			const parsed = await fetchQuota(
				account.provider,
				current,
				AbortSignal.any([signal, AbortSignal.timeout(10000)]),
			);
			signal.throwIfAborted();
			cache.set(account.id, {
				account,
				...parsed,
				fetchedAt: new Date().toISOString(),
				error: null,
			});
		} catch (error) {
			if (signal.aborted) lastAttempt.delete(account.id);
			signal.throwIfAborted();
			const message =
				error instanceof Error &&
				!/fetch|network|abort|timeout/i.test(error.message)
					? error.message
					: "Could not reach the provider. Retry in a minute.";
			cache.set(account.id, { ...result(account), error: message });
		}
	};
	e.handle(quotaRpc, (input, ctx) => {
		// Serialize mutations so cancellation/removal cannot resurrect an account.
		const operation = queue.then(async () => {
			const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
			signal.throwIfAborted();
			let list = await accounts();
			if (input.action === "add" || input.action === "connect") {
				const current = input.action === "connect";
				const existing = current
					? list.find(
							(a) => a.provider === input.provider && a.usesCurrentLogin,
						)
					: undefined;
				if (existing) {
					await refresh(existing, signal);
				} else {
					if (list.length >= 20)
						throw new Error(
							"Maximum 20 accounts. Remove one before adding another.",
						);
					const label =
						input.label.trim() ||
						(input.provider === "codex" ? "Codex" : "Claude Code");
					const credentialPath = current ? "" : input.credentialPath.trim();
					if (label.length > 80)
						throw new Error("Keep the account name under 80 characters.");
					if (!current && (!credentialPath || credentialPath.length > 4096))
						throw new Error("Provide a credential-file path.");
					if (
						!current &&
						list.some(
							(a) =>
								a.provider === input.provider &&
								!a.usesCurrentLogin &&
								a.credentialPath === credentialPath,
						)
					)
						throw new Error("This profile is already connected.");
					const account: AccountProfile = {
						id: crypto.randomUUID(),
						label,
						provider: input.provider,
						credentialPath,
						usesCurrentLogin: current,
					};
					const credential = await readAccountCredential(account, signal);
					sources[input.provider].request(credential);
					signal.throwIfAborted();
					list = [...list, account];
					await e.storage.set("accounts", list);
					// The Connect click both saves the source and reads quota; no second setup step.
					await refresh(account, signal, credential);
				}
			} else if (input.action === "remove") {
				list = list.filter((a) => a.id !== input.id);
				await e.storage.set("accounts", list);
				cache.delete(input.id);
				lastAttempt.delete(input.id);
			} else if (input.action === "refresh") {
				const account = list.find((a) => a.id === input.id);
				if (!account) throw new Error("Select an existing account to refresh.");
				await refresh(account, signal);
			}
			return list.map(result);
		});
		queue = operation.catch(() => {});
		return operation;
	});
	return () => {
		lifetime.abort();
		cache.clear();
		lastAttempt.clear();
	};
}
