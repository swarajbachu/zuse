import { describe, expect, it } from "vitest";
import {
	toolImageDataUrl,
	toolImageResult,
} from "../../src/lib/tool-image-result.ts";

describe("tool image results", () => {
	it("extracts ACP image content through tool content wrappers", () => {
		const image = toolImageResult([
			{
				type: "content",
				content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			},
		]);
		expect(image).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
		expect(image === null ? null : toolImageDataUrl(image)).toBe(
			"data:image/png;base64,aGVsbG8=",
		);
	});

	it("ignores non-image and malformed content", () => {
		expect(toolImageResult({ type: "text", text: "hello" })).toBeNull();
		expect(
			toolImageResult({ type: "image", data: "abc", mimeType: "text/plain" }),
		).toBeNull();
	});
});
