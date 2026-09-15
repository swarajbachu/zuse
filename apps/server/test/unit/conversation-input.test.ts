import { ComposerInput } from "@zuse/contracts";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { serializeAnnotations } from "../../src/conversation/core/conversation-input.ts";

test("context survives transport without becoming visible message text", () => {
	const input = Schema.decodeUnknownSync(ComposerInput)({
		text: "Can you fix these?",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
		annotations: [
			{
				_tag: "context",
				id: "repair",
				label: "7 comments",
				comment:
					"Full review feedback\n\nsrc/checks.ts:42 — preserve the cached checks.",
			},
		],
	});
	const restored = Schema.decodeUnknownSync(ComposerInput)(
		JSON.parse(JSON.stringify(input)),
	);
	expect(restored.text).toBe("Can you fix these?");
	expect(serializeAnnotations(restored.annotations)).toContain(
		"src/checks.ts:42",
	);
	expect(restored.annotations).toEqual(input.annotations);
});

test("context-only input and existing code annotations both reach the provider", () => {
	const input = ComposerInput.make({
		text: "",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
		annotations: [
			{
				id: "code",
				relPath: "src/checks.ts",
				absPath: "/repo/src/checks.ts",
				startLine: 2,
				endLine: 3,
				comment: "Fix this",
			},
			{
				_tag: "context",
				id: "repair",
				label: "Checks",
				comment: "Complete CI output",
			},
		],
	});
	expect(serializeAnnotations(input.annotations)).toBe(
		"Code annotations:\n1. src/checks.ts:2-3 — Fix this\n\nComplete CI output",
	);
});
