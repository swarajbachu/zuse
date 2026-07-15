import {
	type AttachmentRef,
	ComposerInput,
	type LinearContextFile,
} from "@zuse/contracts";

import { appendContextFileRef } from "./draft-attachments.ts";

const LINEAR_AGENT_PREAMBLE =
	"For the selected Linear tickets: move active work into an appropriate started state, post useful progress and completion comments, and only mark work complete after relevant verification. Ask for mutation permission when required. Downloaded ticket images are attached to this message as vision inputs and are also available at the relative paths referenced by the ticket Markdown.";

export const applyPreparedLinearContext = (
	input: ComposerInput,
	prepared: {
		readonly files: ReadonlyArray<LinearContextFile>;
		readonly attachments: ReadonlyArray<AttachmentRef>;
	},
): ComposerInput => {
	const withContext = ComposerInput.make({
		...input,
		text: [LINEAR_AGENT_PREAMBLE, input.text]
			.filter((part) => part.trim().length > 0)
			.join("\n\n"),
		attachments: [...input.attachments, ...prepared.attachments],
	});
	return prepared.files.reduce(
		(current, file) => appendContextFileRef(current, file),
		withContext,
	);
};
