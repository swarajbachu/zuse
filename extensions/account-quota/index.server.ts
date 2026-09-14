import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionServerContext } from "@zuse/extension-sdk";
import { Schema } from "effect";
import {
	Account,
	type AccountProfile,
	type QuotaResult,
	quotaRpc,
} from "./contracts.ts";
import { fetchQuota } from "./providers.ts";
export async function readCredential(path: string) {
	const resolved = path.startsWith("~/")
		? join(homedir(), path.slice(2))
		: path;
	if (!isAbsolute(resolved))
		throw new Error(
			"Enter an absolute credential-file path, or start it with ~/.",
		);
	const file = await open(
		resolved,
		constants.O_RDONLY | constants.O_NONBLOCK,
	).catch(() => {
		throw new Error(
			"Cannot open this profile's credential file. Check its path and permissions.",
		);
	});
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 65536)
			throw new Error(
				"Credential source must be a JSON file smaller than 64 KiB.",
			);
		const bytes = new Uint8Array(65537);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > 65536) throw new Error("Credential file is too large.");
		try {
			return JSON.parse(
				new TextDecoder().decode(bytes.subarray(0, bytesRead)),
			) as unknown;
		} catch {
			throw new Error("Credential file contains invalid JSON.");
		}
	} finally {
		await file.close();
	}
}
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
	e.handle(quotaRpc, (input, ctx) => {
		// A single command queue prevents add/remove/refresh races and resurrection.
		const operation = queue.then(async () => {
			ctx.signal.throwIfAborted();
			lifetime.signal.throwIfAborted();
			let list = await accounts();
			if (input.action === "add") {
				if (list.length >= 20)
					throw new Error(
						"Maximum 20 profiles. Remove a profile before adding another.",
					);
				const label = input.label.trim();
				const credentialPath = input.credentialPath.trim();
				if (!label || label.length > 80)
					throw new Error("Give this account a label of 1–80 characters.");
				if (!credentialPath || credentialPath.length > 4096)
					throw new Error("Provide a credential-file path.");
				if (
					list.some(
						(a) =>
							a.provider === input.provider &&
							a.credentialPath === credentialPath,
					)
				)
					throw new Error("This profile is already connected.");
				// Validate the shape locally; no network request or secret copies on add.
				const credential = await readCredential(credentialPath);
				const { sources } = await import("./providers.ts");
				sources[input.provider].request(credential);
				list = [
					...list,
					{
						id: crypto.randomUUID(),
						label,
						provider: input.provider,
						credentialPath,
					},
				];
				ctx.signal.throwIfAborted();
				await e.storage.set("accounts", list);
			} else if (input.action === "remove") {
				list = list.filter((a) => a.id !== input.id);
				await e.storage.set("accounts", list);
				cache.delete(input.id);
				lastAttempt.delete(input.id);
			} else if (input.action === "refresh") {
				const pending = list.filter((a) => a.id === input.id);
				if (pending.length !== 1)
					throw new Error("Select an existing account to refresh.");
				const refresh = async (account: AccountProfile) => {
					if (Date.now() - (lastAttempt.get(account.id) ?? 0) < 60000) return;
					ctx.signal.throwIfAborted();
					lastAttempt.set(account.id, Date.now());
					try {
						const credential = await readCredential(account.credentialPath);
						const parsed = await fetchQuota(
							account.provider,
							credential,
							AbortSignal.any([
								ctx.signal,
								lifetime.signal,
								AbortSignal.timeout(10000),
							]),
						);
						ctx.signal.throwIfAborted();
						lifetime.signal.throwIfAborted();
						cache.set(account.id, {
							account,
							...parsed,
							fetchedAt: new Date().toISOString(),
							error: null,
						});
					} catch (error) {
						if (ctx.signal.aborted || lifetime.signal.aborted) throw error;
						// Never include provider response bodies, credentials, or request headers.
						const message =
							error instanceof Error &&
							!/fetch|network|abort|timeout/i.test(error.message)
								? error.message
								: "Quota connection failed or timed out. Retry in a minute.";
						cache.set(account.id, { ...result(account), error: message });
					}
				};
				await refresh(pending[0]);
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
