import type { ComposerInput } from "@zuse/contracts";

/**
 * Whether chat creation can persist this input as its atomic initial turn.
 * Structured context uses the startup queue because attachments and references
 * may need to be materialized after the chat itself is acknowledged.
 */
export const composerInputStartsDirectTurn = (input: ComposerInput): boolean =>
	input.text.trim().length > 0 &&
	input.attachments.length === 0 &&
	input.fileRefs.length === 0 &&
	input.skillRefs.length === 0 &&
	input.annotations.length === 0;
