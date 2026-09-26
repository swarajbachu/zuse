import { join } from "node:path";
import { readWorkspaceText, workspaceFiles } from "@zuse/utils/workspace-files";
import { Effect } from "effect";
import { IndexIoError } from "./errors.ts";
export interface WalkedFile {
	readonly relPath: string;
	readonly absPath: string;
	readonly bytes: Buffer;
}
export const walkRepo = (
	root: string,
): Effect.Effect<ReadonlyArray<WalkedFile>, IndexIoError> =>
	Effect.tryPromise({
		try: async () => {
			const files: WalkedFile[] = [];
			for await (const relPath of workspaceFiles(root)) {
				try {
					files.push({
						relPath,
						absPath: join(root, relPath),
						bytes: Buffer.from(await readWorkspaceText(root, relPath)),
					});
				} catch {
					/* unreadable, oversized, or binary */
				}
			}
			return files;
		},
		catch: (cause) =>
			new IndexIoError({ path: root, reason: "walk failed", cause }),
	});
