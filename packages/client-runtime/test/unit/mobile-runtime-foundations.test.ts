import { describe, expect, it, vi } from "vitest";

import {
	containsComposerToken,
	detectComposerTrigger,
	replaceComposerTrigger,
	retainComposerReferences,
} from "../../src/composer-trigger";
import { classifyMedia, sanitizeSvg } from "../../src/media";
import { createTerminalInputPump } from "../../src/terminal-input-pump";
import { toolImageDataUrl, toolImageResult } from "../../src/tool-image-result";

describe("mobile runtime foundations", () => {
	it("detects and replaces file and command triggers only at token boundaries", () => {
		expect(detectComposerTrigger("open @src/app", 13)).toMatchObject({
			kind: "at",
			query: "src/app",
		});
		expect(detectComposerTrigger("email@example", 13)).toBeNull();
		const trigger = detectComposerTrigger("/review", 7);
		expect(trigger).not.toBeNull();
		if (trigger === null) throw new Error("Expected slash trigger");
		expect(replaceComposerTrigger("/review", trigger, "/review ")).toEqual({
			text: "/review ",
			cursor: 8,
		});
		expect(detectComposerTrigger("use $review", 11)).toMatchObject({
			kind: "dollar",
			query: "review",
		});
	});

	it("does not retain a typed reference after its token is extended", () => {
		expect(containsComposerToken("open @src/a", "@src/a")).toBe(true);
		expect(containsComposerToken("open @src/abc", "@src/a")).toBe(false);
		expect(containsComposerToken("/review next", "/review")).toBe(true);
	});

	it("keeps reference identity while ordinary composer text changes", () => {
		const emptyReferences: Array<{ path: string }> = [];
		expect(
			retainComposerReferences(
				emptyReferences,
				"keep writing",
				(reference) => `@${reference.path}`,
			),
		).toBe(emptyReferences);
		const references = [{ path: "src/app.ts" }];
		expect(
			retainComposerReferences(
				references,
				"open @src/app.ts",
				(reference) => `@${reference.path}`,
			),
		).toBe(references);
		expect(
			retainComposerReferences(
				references,
				"open another file",
				(reference) => `@${reference.path}`,
			),
		).toEqual([]);
	});

	it("serializes terminal writes while preserving input queued during an ack", async () => {
		const calls: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const pump = createTerminalInputPump({
			timeoutMs: 1_000,
			write: async (data) => {
				calls.push(data);
				if (calls.length === 1) await first;
			},
			onFailure: vi.fn(),
		});

		pump.enqueue("a");
		pump.enqueue("b");
		releaseFirst?.();
		await pump.whenIdle();
		expect(calls).toEqual(["a", "b"]);
	});

	it("classifies supported previews and strips active SVG content", () => {
		expect(classifyMedia("preview.avif", "image/avif")).toBe("image");
		expect(classifyMedia("notes.pdf", "application/pdf")).toBe("document");
		const sanitized = sanitizeSvg(
			'<svg><script>alert(1)</script><image href="https://tracker.test/x"/></svg>',
		);
		expect(sanitized).not.toContain("<script");
		expect(sanitized).not.toContain("https://");
	});

	it("extracts image-producing tool output without depending on one provider shape", () => {
		const image = toolImageResult({
			result: {
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
		});
		expect(image).toEqual({
			data: "aGVsbG8=",
			mimeType: "image/png",
		});
		if (image === null) throw new Error("Expected tool image");
		expect(toolImageDataUrl(image)).toBe("data:image/png;base64,aGVsbG8=");
	});
});
