import { buildAcpPromptContent } from "@zuse/agents/drivers/acp-image-content";
import type { AttachmentRef } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const attachment: AttachmentRef = {
	id: "image-1",
	mimeType: "image/png",
	originalName: "screen.png",
};

describe("ACP image prompt content", () => {
	it("turns uploaded images into native ACP image blocks", async () => {
		const blocks = await buildAcpPromptContent(
			"Can you read this?",
			[attachment],
			async () => ({
				bytes: new Uint8Array([1, 2, 3]),
				mimeType: "image/png",
				path: "/workspace/.context/files/screen.png",
			}),
		);

		expect(blocks).toEqual([
			{ type: "text", text: "Can you read this?" },
			{
				type: "image",
				data: "AQID",
				mimeType: "image/png",
				uri: "file:///workspace/.context/files/screen.png",
			},
		]);
	});

	it("does not emit fake image blocks for pending or missing uploads", async () => {
		const pending = { ...attachment, id: "pending-123" };
		const blocks = await buildAcpPromptContent(
			"Inspect",
			[pending, attachment],
			async () => null,
		);

		expect(blocks).toEqual([{ type: "text", text: "Inspect" }]);
	});
});
