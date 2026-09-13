import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ComposerInput } from "@zuse/contracts";
import { uploadAttachment } from "../lib/attachments.ts";
import { saveContextFile, saveContextText } from "../lib/context-handoff.ts";
import {
	appendContextFileRef,
	finalizeDraftAttachments,
	finalizeDraftContextFiles,
	type PendingDraftAttachment,
	type PendingDraftContextFile,
} from "./draft-attachments.ts";

/** Where a new chat's first message will live: its session and, for a local
 * checkout whose session row may not exist yet, the workspace root uploads
 * should fall back to. Cloud sandboxes resolve everything from the session. */
export type StartupInputTarget = Readonly<{
	ref: SessionRef;
	uploadRoot: string | null;
}>;

export type StartupInputStage = "context" | "attachment";

export class StartupInputError extends Error {
	readonly stage: StartupInputStage;
	constructor(stage: StartupInputStage, cause: unknown) {
		super(
			stage === "context"
				? "Couldn't attach pasted text. Please try again."
				: "Couldn't attach one of those files. Please try again.",
			{ cause },
		);
		this.name = "StartupInputError";
		this.stage = stage;
	}
}

export type StartupInputOptions = Readonly<{
	/** GitHub issue body chosen through "Create from…"; saved as a context file. */
	issueMarkdown: string | null;
	/** Linear preparation owned by the caller (it decides how failures surface). */
	prepareLinear: ((input: ComposerInput) => Promise<ComposerInput>) | null;
	pendingContextFiles: ReadonlyArray<PendingDraftContextFile>;
	pendingAttachments: ReadonlyArray<PendingDraftAttachment>;
}>;

/** True when the first message references bytes that still have to be
 * written into the chat's workspace before an agent can read them. */
export const startupInputNeedsPreparation = (
	options: Pick<
		StartupInputOptions,
		| "issueMarkdown"
		| "prepareLinear"
		| "pendingContextFiles"
		| "pendingAttachments"
	>,
): boolean =>
	options.issueMarkdown !== null ||
	options.prepareLinear !== null ||
	options.pendingContextFiles.length > 0 ||
	options.pendingAttachments.length > 0;

/**
 * Materialize everything a draft submission referenced into the target
 * session's workspace and return the input that should actually be sent.
 * One sequence for local, remote, and cloud chats: issue context, Linear
 * context, pasted text, then dropped files. Each writes through the target's
 * environment so a cloud sandbox receives its own copies.
 */
export const finalizeStartupInput = async (
	input: ComposerInput,
	target: StartupInputTarget,
	options: StartupInputOptions,
): Promise<ComposerInput> => {
	const { ref, uploadRoot } = target;
	let finalInput = input;
	if (options.issueMarkdown !== null) {
		const contextRef = await saveContextFile(
			ref.environmentId,
			ref.sessionId,
			options.issueMarkdown,
		);
		if (contextRef !== null) {
			finalInput = appendContextFileRef(finalInput, contextRef);
		}
	}
	if (options.prepareLinear !== null) {
		finalInput = await options.prepareLinear(finalInput);
	}
	try {
		finalInput = await finalizeDraftContextFiles(
			finalInput,
			options.pendingContextFiles,
			async (pending) => {
				const saved = await saveContextText({
					environmentId: ref.environmentId,
					sessionId: ref.sessionId,
					text: pending.text,
					ext: pending.ext,
					...(uploadRoot === null ? {} : { rootPath: uploadRoot }),
				});
				return { relPath: saved.relPath, absPath: saved.absPath };
			},
		);
	} catch (cause) {
		throw new StartupInputError("context", cause);
	}
	try {
		finalInput = await finalizeDraftAttachments(
			finalInput,
			options.pendingAttachments,
			(pending) => uploadAttachment(ref, pending.file, uploadRoot ?? undefined),
		);
	} catch (cause) {
		throw new StartupInputError("attachment", cause);
	}
	return finalInput;
};

/**
 * The workspace a brand-new session runs in is registered by the environment
 * that owns it: locally that is done by `create()`, but a cloud sandbox
 * creates its chat and session rows while its runtime comes online. A write
 * that wins that race resolves no workspace root, which is a "not yet"
 * rather than a real failure.
 */
const TARGET_NOT_READY_TAGS = new Set([
	"SessionNotFoundError",
	"ContextWriteError",
]);

export const startupTargetNotReady = (error: unknown): boolean => {
	const cause = error instanceof StartupInputError ? error.cause : error;
	const tag =
		typeof cause === "object" && cause !== null && "_tag" in cause
			? (cause as { readonly _tag: unknown })._tag
			: null;
	return typeof tag === "string" && TARGET_NOT_READY_TAGS.has(tag);
};

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * {@link finalizeStartupInput}, retried while the target session is still
 * being registered. Each attempt restarts from the original input so a
 * partial write is never carried into the message that gets sent.
 */
export const finalizeStartupInputWhenReady = async (
	input: ComposerInput,
	target: StartupInputTarget,
	options: StartupInputOptions,
	retry: { readonly attempts: number; readonly delayMs: number } = {
		attempts: 5,
		delayMs: 700,
	},
): Promise<ComposerInput> => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await finalizeStartupInput(input, target, options);
		} catch (cause) {
			if (attempt >= retry.attempts || !startupTargetNotReady(cause))
				throw cause;
			await delay(retry.delayMs);
		}
	}
};

/** Object URLs backing draft previews are only needed until the bytes upload. */
export const releaseDraftAttachmentPreviews = (
	pending: ReadonlyArray<PendingDraftAttachment>,
): void => {
	for (const item of pending) {
		if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
	}
};
