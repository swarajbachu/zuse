import type {
	ExecutionRef,
	SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	type AttachmentRef,
	CommandId,
	LinearContextFile,
	LinearContextWarning,
} from "@zuse/contracts";
import { readAttachment, uploadAttachmentBytes } from "./attachments.ts";
import { saveContextText } from "./context-handoff.ts";
import { dispatchFileTreeCommand } from "./file-tree-client-bus.ts";

export type PreparedLinearContext = Readonly<{
	files: ReadonlyArray<LinearContextFile>;
	attachments: ReadonlyArray<AttachmentRef>;
	warnings: ReadonlyArray<LinearContextWarning>;
}>;

export type LinearContextTransferIo = Readonly<{
	readFile: (path: string) => Promise<string>;
	saveText: (
		text: string,
	) => Promise<Pick<LinearContextFile, "relPath" | "absPath">>;
	readAttachment: (
		id: string,
	) => Promise<
		Readonly<{ bytes: Uint8Array; mimeType: string; originalName: string }>
	>;
	upload: (input: {
		readonly bytes: Uint8Array;
		readonly mimeType: string;
		readonly originalName: string;
	}) => Promise<AttachmentRef>;
}>;

const readLocalTextFile = async (
	source: ExecutionRef,
	path: string,
): Promise<string> => {
	const { result } = await dispatchFileTreeCommand<
		{
			readonly folderId: ExecutionRef["folderId"];
			readonly worktreeId: ExecutionRef["worktreeId"];
			readonly path: string;
		},
		{ readonly kind: string; readonly content?: string }
	>({
		ref: source,
		kind: "fs.readFile",
		commandId: CommandId.make(`fs-read:${crypto.randomUUID()}`),
		payload: {
			folderId: source.folderId,
			worktreeId: source.worktreeId,
			path,
		},
	});
	if (result.kind !== "text" || result.content === undefined)
		throw new Error(`Linear context ${path} is not a text file.`);
	return result.content;
};

export const linearContextTransferIo = (input: {
	readonly source: ExecutionRef;
	readonly sourceSession: SessionRef;
	readonly target: SessionRef;
}): LinearContextTransferIo => ({
	readFile: (path) => readLocalTextFile(input.source, path),
	saveText: (text) =>
		saveContextText({
			environmentId: input.target.environmentId,
			sessionId: input.target.sessionId,
			text,
			ext: "md",
		}),
	readAttachment: (id) => readAttachment(input.sourceSession, id),
	upload: (file) => uploadAttachmentBytes(input.target, file),
});

/**
 * Linear credentials only exist on the desktop, so issue context is rendered
 * there (`linear.prepareContext` with the local project as the root) and then
 * copied into the environment that will run the chat. Markdown becomes a
 * context file in the target's `.context/files/`; downloaded images are
 * re-uploaded so the message can reference the target's attachment ids.
 * Files that fail to copy become warnings rather than failing the launch.
 */
export const transferLinearContext = async (
	prepared: PreparedLinearContext,
	io: LinearContextTransferIo,
): Promise<PreparedLinearContext> => {
	const files: LinearContextFile[] = [];
	const attachments: AttachmentRef[] = [];
	const warnings: LinearContextWarning[] = [...prepared.warnings];
	for (const file of prepared.files) {
		try {
			const saved = await io.saveText(await io.readFile(file.relPath));
			files.push(
				LinearContextFile.make({
					issue: file.issue,
					relPath: saved.relPath,
					absPath: saved.absPath,
				}),
			);
		} catch (cause) {
			warnings.push(
				LinearContextWarning.make({
					issue: file.issue,
					message: `Context for ${file.issue.identifier} could not be copied to the cloud workspace: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				}),
			);
		}
	}
	for (const attachment of prepared.attachments) {
		try {
			const source = await io.readAttachment(attachment.id);
			attachments.push(
				await io.upload({
					bytes: source.bytes,
					mimeType: source.mimeType,
					originalName: attachment.originalName,
				}),
			);
		} catch (cause) {
			const issue = prepared.files[0]?.issue;
			if (issue !== undefined)
				warnings.push(
					LinearContextWarning.make({
						issue,
						message: `Image ${attachment.originalName} could not be copied to the cloud workspace: ${
							cause instanceof Error ? cause.message : String(cause)
						}`,
					}),
				);
		}
	}
	return { files, attachments, warnings };
};
