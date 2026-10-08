import { Schema } from "effect";

export const HTML_RENDER_MAX_BYTES = 512_000;
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_COLUMN_WIDTH = 728;

const Html = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(HTML_RENDER_MAX_BYTES),
);
export const HtmlPreviewInput = Schema.Struct({
	html: Html,
	width: Schema.optional(
		Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1600 })),
	),
	appearance: Schema.optional(Schema.Literals(["dark", "light"])),
});
export type HtmlPreviewInput = typeof HtmlPreviewInput.Type;

export const HtmlRenderInput = Schema.Struct({
	html: Html,
	title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	height: Schema.Int.check(
		Schema.isBetween({
			minimum: HTML_RENDER_MIN_HEIGHT,
			maximum: HTML_RENDER_MAX_HEIGHT,
		}),
	),
});
export type HtmlRenderInput = typeof HtmlRenderInput.Type;

export const HtmlRenderReference = Schema.Struct({
	attachmentId: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(256),
	),
	title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	height: Schema.Int.check(
		Schema.isBetween({
			minimum: HTML_RENDER_MIN_HEIGHT,
			maximum: HTML_RENDER_MAX_HEIGHT,
		}),
	),
});
export type HtmlRenderReference = typeof HtmlRenderReference.Type;

export interface HtmlPreviewResult {
	readonly width: number;
	readonly contentHeight: number;
	readonly capturedHeight: number;
	readonly consoleMessages: ReadonlyArray<{
		readonly level: string;
		readonly text: string;
	}>;
	readonly screenshot: {
		readonly mimeType: "image/png";
		readonly data: string;
	};
}
