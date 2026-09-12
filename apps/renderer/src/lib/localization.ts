import type { LocalePreference, LocaleSnapshot } from "@zuse/contracts";
import {
	activateLocale,
	availableLocales,
	i18n,
	type Namespace,
	prepareLocale,
	resolveLocale,
} from "@zuse/i18n";
import { useSyncExternalStore } from "react";

const bridge = () =>
	(globalThis.window?.zuse ?? globalThis.window?.memoize)?.locale;
const available = availableLocales(import.meta.env.DEV);
let snapshot: LocaleSnapshot = {
	version: 1,
	revision: -1,
	preference: "system",
	locale: "en",
	available,
};
const listeners = new Set<() => void>();
let requestedRevision = -1;
let initial: Promise<void> | undefined;
let commit = Promise.resolve();

const pending = new Map<number, Promise<void>>();
function accept(next: LocaleSnapshot): Promise<void> {
	const existing = pending.get(next.revision);
	if (existing) return existing;
	if (next.revision <= requestedRevision)
		return pending.get(requestedRevision) ?? Promise.resolve();
	requestedRevision = next.revision;
	const namespaces = [
		...new Set(["common", ...Object.keys(i18n.store.data.en ?? {})]),
	] as Namespace[];
	const operation = prepareLocale(next.locale, namespaces)
		.then(() => {
			const activation = commit.then(async () => {
				if (next.revision !== requestedRevision) return;
				await activateLocale(next.locale);
				snapshot = next;
				document.documentElement.lang = next.locale;
				document.documentElement.dir = "ltr";
				for (const listener of listeners) listener();
			});
			commit = activation.catch(() => {});
			return activation;
		})
		.catch((error) => {
			if (next.revision === requestedRevision)
				requestedRevision = snapshot.revision;
			throw error;
		})
		.finally(() => {
			pending.delete(next.revision);
		});
	pending.set(next.revision, operation);
	return operation;
}

export function initializeLocalization(): Promise<void> {
	if (initial) return initial;
	initial = (async () => {
		const native = bridge();
		if (native) {
			// Subscribe first: a change arriving during get() wins via its revision.
			native.onChange((next) => {
				void accept(next).catch(() => {
					/* The last successfully loaded UI stays usable. */
				});
			});
			await accept(await native.get());
		} else {
			await accept({
				...snapshot,
				revision: 0,
				locale: resolveLocale("system", navigator.languages, available),
			});
		}
	})().catch(async () => {
		const latest = pending.get(requestedRevision);
		if (latest) {
			try {
				await latest;
			} catch {
				/* Recover below if no locale activated. */
			}
		}
		if (snapshot.revision >= 0) return;
		requestedRevision = -1;
		await accept({
			...snapshot,
			revision: 0,
			preference: "system",
			locale: "en",
		});
	});
	return initial;
}

export class LanguageChangeError extends Error {
	constructor(
		readonly kind: "save" | "load",
		options: ErrorOptions,
	) {
		super(`Language ${kind} failed`, options);
	}
}
export async function setLanguage(preference: LocalePreference): Promise<void> {
	const native = bridge();
	let next: LocaleSnapshot;
	if (native) {
		try {
			next = await native.set(preference);
		} catch (cause) {
			throw new LanguageChangeError("save", { cause });
		}
	} else {
		next = {
			...snapshot,
			revision: requestedRevision + 1,
			preference,
			locale: resolveLocale(preference, navigator.languages, available),
		};
	}
	try {
		await accept(next);
	} catch (cause) {
		throw new LanguageChangeError("load", { cause });
	}
}

export function useLocaleSnapshot() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => snapshot,
	);
}
