import type { LocalePreference, LocaleSnapshot } from "@zuse/contracts";
import {
	availableLocales,
	isLocalePreference,
	resolveLocale,
} from "@zuse/i18n/locales";

import { readPreference, writePreference } from "./atomic-preference.ts";

export async function readLocalePreference(
	userData: string,
): Promise<LocalePreference> {
	try {
		return await readPreference(userData, "language.json", (value: unknown) => {
			if (
				value &&
				typeof value === "object" &&
				"version" in value &&
				value.version === 1 &&
				"preference" in value &&
				isLocalePreference(value.preference)
			)
				return value.preference;
			return "system";
		});
	} catch {
		return "system";
	}
}
export async function writeLocalePreference(
	userData: string,
	preference: LocalePreference,
): Promise<void> {
	await writePreference(userData, "language.json", { version: 1, preference });
}

/** Serialize persistence and publish only committed snapshots. Independent of Electron for testing. */
export function createLocaleController(options: {
	preference: LocalePreference;
	languages: () => readonly string[];
	country?: () => string;
	preview?: boolean;
	persist: (preference: LocalePreference) => Promise<void>;
	prepare: (locale: LocaleSnapshot["locale"]) => Promise<void>;
	publish: (snapshot: LocaleSnapshot) => void | Promise<void>;
}) {
	const available = availableLocales(options.preview);
	const preference =
		options.preference === "system" || available.includes(options.preference)
			? options.preference
			: "system";
	let snapshot: LocaleSnapshot = {
		version: 1,
		revision: 0,
		preference,
		locale: resolveLocale(
			preference,
			options.languages(),
			available,
			options.country?.(),
		),
		available,
	};
	let queue = Promise.resolve();
	const update = (
		selectPreference: () => unknown,
		persist: boolean,
	): Promise<LocaleSnapshot> => {
		const operation = queue.then(async () => {
			const preference = selectPreference();
			if (
				!isLocalePreference(preference) ||
				(preference !== "system" && !available.includes(preference))
			)
				throw new Error("Unsupported language preference");
			const locale = resolveLocale(
				preference,
				options.languages(),
				available,
				options.country?.(),
			);
			if (
				!persist &&
				preference === snapshot.preference &&
				locale === snapshot.locale
			)
				return snapshot;
			await options.prepare(locale);
			if (persist) await options.persist(preference);
			snapshot = {
				...snapshot,
				revision: snapshot.revision + 1,
				preference,
				locale,
			};
			await options.publish(snapshot);
			return snapshot;
		});
		queue = operation.then(
			() => {},
			() => {},
		);
		return operation;
	};
	return {
		get: () => snapshot,
		set: (preference: unknown) => update(() => preference, true),
		refresh: () => update(() => snapshot.preference, false),
	};
}
