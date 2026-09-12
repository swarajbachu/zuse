import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalePreference, LocaleSnapshot } from "@zuse/contracts";
import {
	availableLocales,
	isLocalePreference,
	resolveLocale,
} from "@zuse/i18n/locales";

export async function readLocalePreference(
	userData: string,
): Promise<LocalePreference> {
	try {
		const value: unknown = JSON.parse(
			await readFile(join(userData, "language.json"), "utf8"),
		);
		if (
			value &&
			typeof value === "object" &&
			"version" in value &&
			value.version === 1 &&
			"preference" in value &&
			isLocalePreference(value.preference)
		)
			return value.preference;
	} catch {
		/* Missing/corrupt preferences use the system default. */
	}
	return "system";
}
export async function writeLocalePreference(
	userData: string,
	preference: LocalePreference,
): Promise<void> {
	await mkdir(userData, { recursive: true });
	const destination = join(userData, "language.json");
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await writeFile(
			temporary,
			`${JSON.stringify({ version: 1, preference })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Serialize persistence and publish only committed snapshots. Independent of Electron for testing. */
export function createLocaleController(options: {
	preference: LocalePreference;
	languages: () => readonly string[];
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
		locale: resolveLocale(preference, options.languages(), available),
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
			const locale = resolveLocale(preference, options.languages(), available);
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
