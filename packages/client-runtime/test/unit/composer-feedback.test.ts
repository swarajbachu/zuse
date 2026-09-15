import { ComposerInput } from "@zuse/contracts";
import { expect, test } from "vitest";
import {
	composerFeedbackText,
	serializeAnnotations,
} from "../../src/composer-feedback.ts";

test("native plan feedback includes staged PR context and code annotations", () => {
	const input = ComposerInput.make({
		text: "Please revise the plan",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
		annotations: [
			{
				_tag: "context",
				id: "pr",
				label: "PR comments",
				comment: "Complete reviewer feedback",
			},
			{
				id: "code",
				relPath: "src/app.ts",
				absPath: "/repo/src/app.ts",
				startLine: 4,
				endLine: 6,
				comment: "Keep this API",
			},
		],
	});
	expect(composerFeedbackText(input)).toBe(
		`${input.text}\n\n${serializeAnnotations(input.annotations)}`,
	);
	expect(composerFeedbackText(input)).toContain("Complete reviewer feedback");
	expect(composerFeedbackText(input)).toContain("src/app.ts:4-6");
	expect(input.text).toBe("Please revise the plan");
	expect(
		composerFeedbackText(ComposerInput.make({ ...input, annotations: [] })),
	).toBe(input.text);
});
