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
			"Review @src/app.ts with $audit carefully [image:attachment-1]",
		);
		expect(snapshot.chips.map((chip) => chip.meta.kind)).toEqual([
			"file",
			"skill",
			"image",
		]);
	});
});

it("settles an image upload in an inactive draft without changing its text or other attachments", async () => {
	const { settleComposerDraftImage } = await import(
		"../../src/composer/input-snapshot.ts"
	);
	const original = {
		doc: "draft [image:pending-test] after",
		chips: [
			{
				from: 6,
				to: 26,
				meta: {
					kind: "image" as const,
					id: "pending-test",
					mimeType: "image/png",
					originalName: "test.png",
					previewUrl: "blob:pending",
				},
			},
		],
	};
	const complete = settleComposerDraftImage(original, "pending-test", {
		kind: "image",
		id: "uploaded",
		mimeType: "image/png",
		originalName: "test.png",
		previewUrl: "blob:uploaded",
	});
	expect(complete.doc).toBe(original.doc);
	expect(complete.chips[0]?.meta).toMatchObject({
		id: "uploaded",
		previewUrl: "blob:uploaded",
	});
	expect(settleComposerDraftImage(original, "unrelated", null)).toBe(original);
});
it("removes a failed offscreen upload using the same chip range mapping as the editor", async () => {
	const { settleComposerDraftImage } = await import(
		"../../src/composer/input-snapshot.ts"
	);
	const original = {
		doc: "[image:pending-test] after",
		chips: [
			{
				from: 0,
				to: 20,
				meta: {
					kind: "image" as const,
					id: "pending-test",
					mimeType: "image/png",
					originalName: "test.png",
					previewUrl: "blob:pending",
				},
			},
		],
	};
	const failed = settleComposerDraftImage(original, "pending-test", null);
	expect(failed.chips).toEqual([]);
	expect(failed.doc).toBe(" after");
});
