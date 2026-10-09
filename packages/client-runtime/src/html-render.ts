import { HtmlRenderReference } from "@zuse/contracts";
import { Schema } from "effect";

const decode = Schema.decodeUnknownOption(HtmlRenderReference);

/** Only app-owned tool names may turn a result into executable content. */
export const isHtmlRenderTool = (name: string): boolean =>
	/^(?:html_render|(?:mcp__)?zuse(?:__|\.|_)html_render)$/i.test(name);

/** Provider adapters preserve MCP results in several envelopes. Bound traversal. */
export function readHtmlRenderResult(
	value: unknown,
	depth = 0,
): HtmlRenderReference | null {
	if (depth > 6 || value === null || value === undefined) return null;
	if (typeof value === "string") {
		if (value.length > 32_000) return null;
		try {
			return readHtmlRenderResult(JSON.parse(value), depth + 1);
		} catch {
			return null;
		}
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 32)) {
			const result = readHtmlRenderResult(item, depth + 1);
			if (result) return result;
		}
		return null;
	}
	if (typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.isError === true || "ErrorOutput" in record) return null;
	const reference = decode(record.htmlRender);
	if (reference._tag === "Some") return reference.value;
	for (const key of [
		"structuredContent",
		"content",
		"text",
		"output",
		"result",
		"OkayOutput",
	]) {
		const result = readHtmlRenderResult(record[key], depth + 1);
		if (result) return result;
	}
	return null;
}
