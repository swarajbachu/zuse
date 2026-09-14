import DOMPurify from "dompurify";
export const defaultInstructions = `Stay in Plan mode. Do not implement changes or request execution approval yet.
Explain the proposed work in plain language. Return a complete self-contained HTML document in one fenced html block, including:
- A short problem statement and the intended outcome.
- A before/after diagram drawn with inline SVG or CSS boxes and arrows.
- A flow diagram showing how the main parts interact.
- Numbered implementation steps, with the files or modules affected.
- Tradeoffs, open questions, failure cases, and a concrete testing checklist.
Use readable typography, clear labels, accessible contrast, and a compact layout. Prefer drawings and specific examples over long paragraphs. Use only static HTML, inline CSS and inline SVG: no JavaScript, external assets, fonts, network requests, forms, or iframes. Do not write files just to display the plan. If your provider requires a Markdown plan, put the HTML code block inside it.`;
export function extractHtml(text: string) {
	if (text.length > 128 * 1024)
		throw new Error("Plan exceeds the 128 KiB preview limit.");
	const fenced = [...text.matchAll(/```html\s*\n([\s\S]*?)```/gi)].at(-1)?.[1];
	if (fenced) return fenced;
	if (
		/^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(text) &&
		/<\/html>\s*$/i.test(text)
	)
		return text;
	return null;
}
export function previewDocument(html: string) {
	if (html.length > 128 * 1024)
		throw new Error("Plan exceeds the 128 KiB preview limit.");
	const clean = DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true, svg: true },
		ADD_TAGS: ["style"],
		FORBID_TAGS: [
			"script",
			"iframe",
			"object",
			"embed",
			"form",
			"input",
			"button",
			"textarea",
			"select",
			"meta",
			"base",
			"link",
			"foreignObject",
			"audio",
			"video",
		],
		FORBID_ATTR: [
			"href",
			"xlink:href",
			"src",
			"srcset",
			"action",
			"formaction",
			"target",
		],
	});
	return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';"><meta charset="utf-8"><style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#202124;background:#fff}svg{max-width:100%;height:auto}pre{white-space:pre-wrap}*{box-sizing:border-box}</style></head><body>${clean}</body></html>`;
}
