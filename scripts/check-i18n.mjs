import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const catalogRoot = resolve(root, "packages/i18n/locales");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function sourceRevision(catalogs) {
	return createHash("sha256")
		.update(
			JSON.stringify(
				Object.entries(catalogs)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([namespace, messages]) => [
						namespace,
						Object.entries(messages).sort(([a], [b]) => a.localeCompare(b)),
					]),
			),
		)
		.digest("hex");
}
const placeholders = (text) =>
	[...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]).sort();
export function validateMessage(source, translated) {
	if (
		typeof translated === "string" &&
		/[XZVQ]{2}\s*\d{3,4}\s*[XZVQ]/i.test(translated)
	)
		return "unresolved machine-translation marker";
	if (typeof translated !== "string" || translated.trim().length === 0)
		return "missing or empty translation";
	if (
		JSON.stringify(placeholders(source)) !==
		JSON.stringify(placeholders(translated))
	)
		return "interpolation placeholders differ";
	const expectedTags = [...source.matchAll(/<\/?(part\d+)\s*\/?\s*>/g)]
		.map((match) => match[0])
		.sort();
	const actualTags = [...translated.matchAll(/<[^>]+>/g)].map(
		(match) => match[0],
	);
	// RichMessage components never accept translator-supplied attributes or tag names.
	if (expectedTags.length) {
		if (actualTags.some((tag) => !/^<\/?part\d+\s*\/?\s*>$/.test(tag)))
			return "unexpected rich-text tag or attributes";
		if (JSON.stringify(expectedTags) !== JSON.stringify([...actualTags].sort()))
			return "rich-text components differ";
		const stack = [];
		for (const tag of actualTags) {
			if (tag.endsWith("/>")) continue;
			if (tag.startsWith("</")) {
				if (stack.pop() !== tag.slice(2, -1))
					return "unbalanced rich-text components";
			} else stack.push(tag.slice(1, -1));
		}
		if (stack.length) return "unbalanced rich-text components";
	} else if (actualTags.some((tag) => !source.includes(tag)))
		return "translation introduced markup";
	return null;
}
export function validatePlurals(source, target, locale) {
	const errors = [];
	const categories = new Intl.PluralRules(
		locale === "en-XA" ? "en" : locale,
	).resolvedOptions().pluralCategories;
	const stems = new Set(
		Object.keys(source)
			.filter((key) => /_(one|other)$/.test(key))
			.map((key) => key.replace(/_(one|other)$/, "")),
	);
	for (const stem of stems) {
		if (!source[`${stem}_other`])
			errors.push(`${stem}: English plural requires other`);
		for (const category of categories) {
			const key = `${stem}_${category}`;
			const problem = validateMessage(
				source[key] ?? source[`${stem}_other`] ?? "",
				target[key],
			);
			if (problem) errors.push(`${key}: ${problem}`);
		}
	}
	for (const key of Object.keys(target)) {
		if (key in source) continue;
		const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
		if (!match || !stems.has(match[1]) || !categories.includes(match[2]))
			errors.push(`${key}: obsolete key`);
	}
	return errors;
}
const walk = (directory) =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(resolve(directory, entry.name))
			: [resolve(directory, entry.name)],
	);
export function findLiteralCopy(file, source) {
	const ast = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const found = [];
	const attributes = new Set([
		"title",
		"label",
		"description",
		"placeholder",
		"aria-label",
		"ariaLabel",
		"alt",
		"emptyMessage",
		"searchPlaceholder",
	]);
	const add = (node, text) => {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (/[A-Za-z]{2}/.test(normalized))
			found.push({
				text: normalized,
				line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
			});
	};
	const expression = (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
			add(node, node.text);
		else if (
			ts.isTemplateExpression(node) &&
			/[A-Za-z]{2}/.test(
				node.head.text +
					node.templateSpans.map((span) => span.literal.text).join(""),
			)
		)
			add(node, node.getText(ast));
		else if (ts.isConditionalExpression(node)) {
			expression(node.whenTrue);
			expression(node.whenFalse);
		} else if (
			ts.isBinaryExpression(node) &&
			[ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
				node.operatorToken.kind,
			)
		)
			expression(node.right);
	};
	const nativeProperties = new Set([
		"label",
		"title",
		"message",
		"detail",
		"buttons",
	]);
	const visit = (node) => {
		if (
			ts.isJsxElement(node) &&
			["style", "script"].includes(node.openingElement.tagName.getText(ast))
		)
			return;
		if (
			file.includes("apps/desktop/") &&
			ts.isPropertyAssignment(node) &&
			nativeProperties.has(node.name.getText(ast).replaceAll('"', ""))
		) {
			let parent = node.parent;
			let nativeDialog = file.endsWith("/menu.ts");
			while (parent && !ts.isSourceFile(parent)) {
				if (
					(ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
					/(?:showMessageBox(?:Sync)?|Notification)$/.test(
						parent.expression.getText(ast),
					)
				)
					nativeDialog = true;
				parent = parent.parent;
			}
			if (nativeDialog) {
				if (ts.isArrayLiteralExpression(node.initializer))
					node.initializer.elements.forEach(expression);
				else expression(node.initializer);
			}
		}
		if (ts.isJsxText(node)) add(node, node.getFullText(ast));
		else if (
			ts.isJsxAttribute(node) &&
			attributes.has(node.name.getText(ast)) &&
			node.initializer
		) {
			if (ts.isStringLiteral(node.initializer))
				add(node.initializer, node.initializer.text);
			else if (
				ts.isJsxExpression(node.initializer) &&
				node.initializer.expression
			)
				expression(node.initializer.expression);
		} else if (
			ts.isJsxExpression(node) &&
			!ts.isJsxAttribute(node.parent) &&
			node.expression
		)
			expression(node.expression);
		ts.forEachChild(node, visit);
	};
	visit(ast);
	return found;
}
export function checkLocalization() {
	const errors = [];
	const english = Object.fromEntries(
		readdirSync(`${catalogRoot}/en/desktop`)
			.filter((file) => file.endsWith(".json"))
			.map((file) => [
				file.slice(0, -5),
				readJson(`${catalogRoot}/en/desktop/${file}`),
			]),
	);
	const revision = sourceRevision(english);
	const reviews = readJson(resolve(root, "packages/i18n/review/desktop.json"));
	for (const locale of Object.keys(
		readJson(resolve(root, "packages/i18n/locales/registry.json")),
	)) {
		for (const [namespace, source] of Object.entries(english)) {
			const target = readJson(
				`${catalogRoot}/${locale}/desktop/${namespace}.json`,
			);
			for (const [key, text] of Object.entries(source)) {
				const problem = validateMessage(text, target[key]);
				if (problem) errors.push(`${locale}/${namespace}:${key}: ${problem}`);
			}
			for (const problem of validatePlurals(source, target, locale))
				errors.push(`${locale}/${namespace}:${problem}`);
		}
		if (
			locale !== "en-XA" &&
			reviews[locale]?.status === "reviewed" &&
			(reviews[locale].sourceRevision !== revision || !reviews[locale].reviewer)
		)
			errors.push(
				`${locale}: review is missing or stale for the current English source`,
			);
	}
	const exceptions = readJson(resolve(root, "scripts/i18n-exceptions.json"));
	for (const file of [
		...walk(resolve(root, "apps/renderer/src")).filter((file) =>
			file.endsWith(".tsx"),
		),
		...["main.ts", "menu.ts"].map((file) =>
			resolve(root, "apps/desktop/src", file),
		),
	]) {
		const relative = file.slice(root.length + 1);
		for (const finding of findLiteralCopy(file, readFileSync(file, "utf8"))) {
			if (
				!exceptions.some(
					(entry) =>
						entry.file === relative &&
						entry.text === finding.text &&
						entry.reason,
				)
			)
				errors.push(
					`${relative}:${finding.line}: untranslated UI literal ${JSON.stringify(finding.text)}`,
				);
		}
	}
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(
		`Localization checked: ${Object.values(english).reduce((count, values) => count + Object.keys(values).length, 0)} messages, 7 languages and pseudo-language. Reviewed: ${Object.entries(
			reviews,
		)
			.filter(([, review]) => review.status === "reviewed")
			.map(([locale]) => locale)
			.join(", ")}.`,
	);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		checkLocalization();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
