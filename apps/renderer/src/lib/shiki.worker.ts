/// <reference lib="webworker" />

import { createHighlighter, type Highlighter } from "shiki";
import { SHIKI_LANGUAGES, SHIKI_THEMES } from "./shiki-config.ts";

type HighlightRequest = {
	readonly id: number;
	readonly code: string;
	readonly lang: (typeof SHIKI_LANGUAGES)[number];
	readonly theme: string;
};

let highlighter: Promise<Highlighter> | null = null;

const getHighlighter = (): Promise<Highlighter> => {
	highlighter ??= createHighlighter({
		themes: [...SHIKI_THEMES],
		langs: [...SHIKI_LANGUAGES],
	});
	return highlighter;
};

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
	const { id, code, lang, theme } = event.data;
	void getHighlighter()
		.then((instance) =>
			instance.codeToHtml(code, {
				lang,
				theme,
				transformers: [
					{
						line(node, line) {
							node.properties["data-line"] = String(line);
						},
					},
				],
			}),
		)
		.then((html) => self.postMessage({ id, html }))
		.catch((error: unknown) =>
			self.postMessage({
				id,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
});
