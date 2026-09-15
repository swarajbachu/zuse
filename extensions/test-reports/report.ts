import type { ExtensionAttachmentSnapshot } from "@zuse/extension-sdk";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const array = (value: unknown): unknown[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown): string =>
	typeof value === "string"
		? value
		: typeof value === "number"
			? String(value)
			: String(object(value)["#text"] ?? "");
export function parseReport(
	xml: string,
	path: string,
): ExtensionAttachmentSnapshot[] {
	if (new TextEncoder().encode(xml).length > 1_500_000)
		throw new Error("Report exceeds the 1.5 MB limit.");
	if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml))
		throw new Error(
			"Reports containing DTDs or entity declarations are not supported.",
		);
	const valid = XMLValidator.validate(xml);
	if (valid !== true) throw new Error(`Malformed XML: ${valid.err.msg}`);
	const document = object(
		new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
			processEntities: false,
			parseTagValue: false,
			parseAttributeValue: false,
		}).parse(xml),
	);
	if (!("testsuite" in document) && !("testsuites" in document))
		throw new Error("Expected a JUnit testsuite or testsuites report.");
	const out: ExtensionAttachmentSnapshot[] = [];
	const visit = (raw: unknown, parent: string, depth: number) => {
		if (depth > 32) throw new Error("Report nesting is too deep.");
		const suite = object(raw);
		const name = String(suite.name ?? parent);
		for (const test of array(suite.testcase)) {
			const value = object(test);
			const status =
				value.failure !== undefined
					? "failed"
					: value.error !== undefined
						? "error"
						: value.skipped !== undefined
							? "skipped"
							: "passed";
			const detail = value.failure ?? value.error ?? value.skipped;
			const message = array(detail)
				.map((item) =>
					[object(item).message, text(item)].filter(Boolean).join("\n"),
				)
				.join("\n\n");
			const title = `${status.toUpperCase()}: ${String(value.name ?? "Unnamed test")}`;
			out.push({
				id: `${path}:${out.length}`,
				metadata: { status, file: path },
				title,
				subtitle: `${name} · ${String(value.classname ?? "")} · ${path}`,
				text: `Report: ${path}\nSuite: ${name}\nTest: ${String(value.name ?? "Unnamed test")}\nStatus: ${status}\n${message}`,
			});
		}
		for (const child of array(suite.testsuite)) visit(child, name, depth + 1);
	};
	for (const suite of array(document.testsuite)) visit(suite, "", 0);
	for (const suites of array(document.testsuites)) visit(suites, "", 0);
	return out.sort(
		(a, b) =>
			Number(a.title.startsWith("PASSED")) -
			Number(b.title.startsWith("PASSED")),
	);
}
