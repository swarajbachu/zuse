import type {
	BrowserAnnotation,
	CodeAnnotation,
	ComposerAnnotation,
	ComposerInput,
} from "@zuse/contracts";

const isBrowserAnnotation = (
	annotation: ComposerAnnotation,
): annotation is BrowserAnnotation =>
	"_tag" in annotation && annotation._tag === "browser";

const serializeCodeAnnotations = (
	annotations: ReadonlyArray<CodeAnnotation>,
): string => {
	const lines = annotations.map((annotation, index) => {
		const range =
			annotation.startLine === annotation.endLine
				? `${annotation.startLine}`
				: `${annotation.startLine}-${annotation.endLine}`;
		const side =
			annotation.diffSide === undefined ? "" : ` (${annotation.diffSide} side)`;
		const previous =
			annotation.oldPath === undefined
				? ""
				: `, previously ${annotation.oldPath}`;
		const base =
			annotation.baseRef === undefined ? "" : `, base ${annotation.baseRef}`;
		return `${index + 1}. ${annotation.relPath}:${range}${side}${previous}${base} — ${annotation.comment}`;
	});
	return ["Code annotations:", ...lines].join("\n");
};

const serializeBrowserAnnotations = (
	annotations: ReadonlyArray<BrowserAnnotation>,
): string => {
	const lines = annotations.map((annotation, index) => {
		const targetCount =
			annotation.elements.length +
			annotation.regions.length +
			annotation.strokes.length;
		const firstElement = annotation.elements[0];
		const target =
			firstElement !== undefined
				? `<${firstElement.tagName}> ${firstElement.label}`.trim()
				: `${targetCount} visual ${targetCount === 1 ? "target" : "targets"}`;
		const title =
			annotation.pageTitle !== null && annotation.pageTitle.trim().length > 0
				? ` (${annotation.pageTitle.trim()})`
				: "";
		const screenshot =
			annotation.screenshotAttachment !== null ? " Screenshot attached." : "";
		return `${index + 1}. ${annotation.pageUrl}${title} — ${target}; ${annotation.comment}.${screenshot}`;
	});
	return ["Browser annotations:", ...lines].join("\n");
};

export const serializeAnnotations = (
	annotations: ReadonlyArray<ComposerAnnotation>,
): string => {
	const code = annotations.filter(
		(annotation): annotation is CodeAnnotation => !("_tag" in annotation),
	);
	const browser = annotations.filter(isBrowserAnnotation);
	return [
		code.length > 0 ? serializeCodeAnnotations(code) : "",
		browser.length > 0 ? serializeBrowserAnnotations(browser) : "",
		...annotations
			.filter((a) => "_tag" in a && a._tag === "context")
			.map((a) => a.comment),
	]
		.filter((section) => section.length > 0)
		.join("\n\n");
};

/** Native plan tools accept text, so include the same annotation context as normal sends. */
export function composerFeedbackText(input: ComposerInput): string {
	return [input.text, serializeAnnotations(input.annotations)]
		.filter(Boolean)
		.join("\n\n");
}
