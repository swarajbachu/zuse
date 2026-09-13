import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findLiteralCopy,
	sourceRevision,
	validateMessage,
	validatePlurals,
} from "./check-i18n.mjs";
import { websiteLocalizationSources } from "./website-localization-sources.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
export function checkWebsiteLocalization() {
	const english = Object.fromEntries(
		readdirSync(resolve(root, "packages/i18n/locales/en/website"))
			.filter((file) => file.endsWith(".json"))
			.map((file) => [
				file.slice(0, -5),
				read(`packages/i18n/locales/en/website/${file}`),
			]),
	);
	const errors = [];
	const reviews = read("packages/i18n/review/website.json");
	for (const locale of Object.keys(
		read("packages/i18n/locales/registry.json"),
	).filter((locale) => locale !== "en-XA")) {
		for (const [ns, source] of Object.entries(english)) {
			const translated = read(
				`packages/i18n/locales/${locale}/website/${ns}.json`,
			);
			for (const [key, text] of Object.entries(source)) {
				const problem = validateMessage(text, translated[key]);
				if (problem) errors.push(`${locale}/${ns}:${key}: ${problem}`);
			}
			for (const problem of validatePlurals(source, translated, locale))
				errors.push(`${locale}/${ns}: ${problem}`);
		}
		if (!reviews[locale])
			errors.push(`${locale}: missing website review metadata`);
		else if (
			reviews[locale].status === "reviewed" &&
			(!reviews[locale].reviewer ||
				reviews[locale].sourceRevision !== sourceRevision(english))
		)
			errors.push(`${locale}: website review is missing or stale`);
	}
	const exceptions = read("scripts/website-i18n-exceptions.json");
	for (const file of websiteLocalizationSources()) {
		for (const finding of findLiteralCopy(
			file,
			readFileSync(resolve(root, file), "utf8"),
		))
			if (
				!exceptions.some(
					(exception) =>
						exception.file === file && exception.text === finding.text,
				)
			)
				errors.push(
					`${file}:${finding.line}: untranslated UI literal ${JSON.stringify(finding.text)}`,
				);
	}
	return {
		errors,
		count: Object.values(english).reduce(
			(count, namespace) => count + Object.keys(namespace).length,
			0,
		),
	};
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { errors, count } = checkWebsiteLocalization();
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else
		console.log(
			`Website localization checked: ${count} messages across seven languages.`,
		);
}
