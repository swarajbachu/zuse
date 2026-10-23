import type { Message } from "@zuse/contracts";
import { expect, test } from "vitest";
import { collectChatImages, markdownImages } from "../../src/lib/chat-images";

test("collects inline and reference images, excluding code and unsafe sources", () => {
	expect(
		markdownImages(
			"![One](/tmp/a.png)\n\n![Two][shot]\n\n[shot]: https://example.com/b.png\n\n`![Code](fake.png)`\n\n![Bad](javascript:alert)",
		),
	).toEqual([
		{ src: "/tmp/a.png", alt: "One" },
		{ src: "https://example.com/b.png", alt: "Two" },
	]);
});

test("collects the full transcript in order, excludes user images, and deduplicates", () => {
	const messages = [
		{ content: { _tag: "user", text: "![User](user.png)" } },
		{ content: { _tag: "assistant", text: "![First](first.png)" } },
		{
			content: {
				_tag: "tool_result",
				isError: false,
				output: {
					content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				},
			},
		},
		{
			content: {
				_tag: "assistant",
				text: "![Again](first.png)\n\n![Last](last.png)",
			},
		},
		{
			content: {
				_tag: "tool_result",
				isError: true,
				output: {
					content: [{ type: "image", data: "failed", mimeType: "image/png" }],
				},
			},
		},
	] as unknown as Message[];
	expect(collectChatImages(messages).map((image) => image.src)).toEqual([
		"first.png",
		"data:image/png;base64,abc",
		"last.png",
	]);
});
