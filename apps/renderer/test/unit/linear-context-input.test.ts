import { ComposerInput } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { applyPreparedLinearContext } from "../../src/composer/linear-context-input.ts";

describe("prepared Linear context", () => {
	it("adds ticket markdown and downloaded images to the initial message", () => {
		const input = ComposerInput.make({
			text: "Finish the selected work",
			attachments: [
				{
					id: "existing-image",
					mimeType: "image/jpeg",
					originalName: "existing.jpg",
				},
			],
			fileRefs: [],
			skillRefs: [],
			annotations: [],
		});
		const result = applyPreparedLinearContext(input, {
			files: [
				{
					issue: {
						workspaceId: "workspace-1",
						issueId: "issue-1",
						identifier: "ABC-123",
					},
					relPath: ".context/linear/team/ABC-123.md",
					absPath: "/workspace/.context/linear/team/ABC-123.md",
				},
			],
			attachments: [
				{
					id: "session-image-1",
					mimeType: "image/png",
					originalName: "ABC-123-image.png",
				},
			],
		});

		expect(result.fileRefs).toHaveLength(1);
		expect(result.attachments).toEqual([
			{
				id: "existing-image",
				mimeType: "image/jpeg",
				originalName: "existing.jpg",
			},
			{
				id: "session-image-1",
				mimeType: "image/png",
				originalName: "ABC-123-image.png",
			},
		]);
		expect(result.text).toContain("Downloaded ticket images are attached");
	});
});
