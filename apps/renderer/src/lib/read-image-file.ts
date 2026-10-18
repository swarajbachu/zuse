import { CommandId, EnvironmentId, type FsFileContent } from "@zuse/contracts";
import type { OpenFile } from "../store/ui.ts";
import { dispatchFileTreeCommand } from "./file-tree-client-bus.ts";
import { readLocalExternalFile } from "./local-device-client-bus.ts";
import { getLocalEnvironmentId, type MemoizeClient } from "./rpc-client.ts";

export async function readImageFile(
	openFile:
		| Omit<Extract<OpenFile, { kind: "text" }>, "view">
		| Omit<Extract<OpenFile, { kind: "external" }>, "view">,
): Promise<typeof FsFileContent.Type> {
	return openFile.kind === "external"
		? await readLocalExternalFile<typeof FsFileContent.Type>(openFile.absPath)
		: (
				await dispatchFileTreeCommand<
					Parameters<MemoizeClient["fs.readFile"]>[0],
					typeof FsFileContent.Type
				>({
					ref: {
						environmentId: EnvironmentId.make(
							openFile.environmentId ?? getLocalEnvironmentId(),
						),
						folderId: openFile.folderId,
						worktreeId: openFile.worktreeId,
						rootPath: "",
					},
					kind: "fs.readFile",
					commandId: CommandId.make(`fs-read:${crypto.randomUUID()}`),
					payload: {
						folderId: openFile.folderId,
						path: openFile.path,
						worktreeId: openFile.worktreeId,
					},
				})
			).result;
}
