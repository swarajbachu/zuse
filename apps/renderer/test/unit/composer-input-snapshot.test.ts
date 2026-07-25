import { ComposerInput } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { composerSnapshotFromInput } from "../../src/composer/input-snapshot.ts";

describe("composerSnapshotFromInput", () => {
	it("restores queued text, files, skills, and attachments as regular composer chips", () => {
		const snapshot = composerSnapshotFromInput(
			ComposerInput.make({
				text: "Review @src/app.ts with /audit carefully",
				fileRefs: [
					{
						relPath: "src/app.ts",
						absPath: "/workspace/src/app.ts",
						kind: "file",
					},
				],
				skillRefs: [
					{
						name: "audit",
						scope: "project",
						args: "carefully",
						providerId: "codex",
					},
				],
				attachments: [
					{
						id: "attachment-1",
						mimeType: "application/pdf",
						originalName: "spec.pdf",
					},
				],
			}),
		);

		expect(snapshot.doc).toBe(
			"Review @src/app.ts with /audit carefully [image:attachment-1]",
		);
		expect(snapshot.chips.map((chip) => chip.meta.kind)).toEqual([
			"file",
			"skill",
			"image",
		]);
	});
});
