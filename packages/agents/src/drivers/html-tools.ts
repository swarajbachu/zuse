import {
	HTML_RENDER_MAX_BYTES,
	HtmlPreviewInput,
	type HtmlPreviewResult,
	HtmlRenderInput,
	type HtmlRenderReference,
} from "@zuse/contracts";
import { Context, Schema } from "effect";

export interface HtmlToolsClient {
	readonly preview: (
		sessionId: string,
		cwd: string,
		input: HtmlPreviewInput,
		signal: AbortSignal,
	) => Promise<HtmlPreviewResult>;
	readonly render: (
		sessionId: string,
		cwd: string,
		input: HtmlRenderInput,
		signal: AbortSignal,
	) => Promise<HtmlRenderReference>;
}

/** Server composition supplies this capability; provider drivers share the gateway. */
export class HtmlTools extends Context.Service<HtmlTools, HtmlToolsClient>()(
	"@zuse/agents/HtmlTools",
) {}

const html = { type: "string", minLength: 1, maxLength: HTML_RENDER_MAX_BYTES };
const guide =
	"Use a complete HTML document with inline CSS and JavaScript. Public HTTP(S) assets are allowed. Absolute workspace image paths are embedded. Use CSS variables --background, --foreground, --muted, --muted-foreground, --primary, --border, --font-sans to match Zuse. Use responsive layouts, a transparent body, and avoid fixed page heights.";
export const HTML_MCP_TOOLS = [
	{
		name: "html_preview",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		description: `Preview an interactive visual before publishing. Returns a PNG screenshot, content height and console output. ${guide}`,
		inputSchema: {
			type: "object",
			properties: {
				html,
				width: { type: "integer", minimum: 240, maximum: 1600, default: 728 },
				appearance: {
					type: "string",
					enum: ["dark", "light"],
					default: "dark",
				},
			},
			required: ["html"],
			additionalProperties: false,
		},
	},
	{
		name: "html_render",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description: `Publish an interactive HTML visual inline in this conversation before your final reply. Preview with html_preview first. The reader sees the visual; add only what it does not say. Set height to the preview's contentHeight (80–2000px); taller content scrolls inside the frame. ${guide}`,
		inputSchema: {
			type: "object",
			properties: {
				html,
				title: { type: "string", minLength: 1, maxLength: 200 },
				height: { type: "integer", minimum: 80, maximum: 2000 },
			},
			required: ["html", "title", "height"],
			additionalProperties: false,
		},
	},
] as const;

export async function handleHtmlTool(
	name: string,
	args: unknown,
	options: { client: HtmlToolsClient; sessionId: string; cwd: string },
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (name === "html_preview") {
		const input = Schema.decodeUnknownSync(HtmlPreviewInput)(args);
		if (Buffer.byteLength(input.html) > HTML_RENDER_MAX_BYTES)
			throw new Error("HTML exceeds 512 KB");
		const { screenshot, ...result } = await options.client.preview(
			options.sessionId,
			options.cwd,
			input,
			signal,
		);
		return {
			content: [
				{ type: "image" as const, ...screenshot },
				{ type: "text" as const, text: JSON.stringify(result) },
			],
		};
	}
	if (name !== "html_render") throw new Error(`Unknown tool: ${name}`);
	const input = Schema.decodeUnknownSync(HtmlRenderInput)(args);
	if (Buffer.byteLength(input.html) > HTML_RENDER_MAX_BYTES)
		throw new Error("HTML exceeds 512 KB");
	if (!input.title.trim()) throw new Error("A title is required");
	const htmlRender = await options.client.render(
		options.sessionId,
		options.cwd,
		input,
		signal,
	);
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ htmlRender }) }],
		structuredContent: { htmlRender },
	};
}
