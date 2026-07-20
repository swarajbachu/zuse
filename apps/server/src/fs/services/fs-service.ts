import type {
	DirectoryUnavailableError,
	FolderId,
	FsAlreadyExistsError,
	FsConflictError,
	FsEntry,
	FsExternalConflictError,
	FsExternalReadError,
	FsExternalTooLargeError,
	FsFileContent,
	FsFolderNotFoundError,
	FsPathOutsideError,
	FsReadError,
	FsTooLargeError,
	WorktreeId,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

type TreeFailure =
	| FsFolderNotFoundError
	| DirectoryUnavailableError
	| FsPathOutsideError
	| FsReadError;
type ReadFileFailure = TreeFailure | FsTooLargeError;
type WriteFileFailure = ReadFileFailure | FsConflictError;
type CreateFailure = TreeFailure | FsAlreadyExistsError;
type ReadExternalFailure = FsExternalReadError | FsExternalTooLargeError;
type WriteExternalFailure = ReadExternalFailure | FsExternalConflictError;

export interface FsServiceShape {
	readonly tree: (
		folderId: FolderId,
		relPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<ReadonlyArray<FsEntry>, TreeFailure>;
	readonly watchTree: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Stream.Stream<{ readonly paths: ReadonlyArray<string> }, TreeFailure>;
	readonly listPaths: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<
		{ readonly paths: ReadonlyArray<string>; readonly truncated: boolean },
		TreeFailure
	>;
	readonly move: (
		folderId: FolderId,
		fromPath: string,
		toPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<Record<string, never>, CreateFailure>;
	readonly readFile: (
		folderId: FolderId,
		relPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<typeof FsFileContent.Type, ReadFileFailure>;
	readonly writeFile: (
		folderId: FolderId,
		relPath: string,
		content: string,
		expectedMtime: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<{ readonly mtime: string }, WriteFileFailure>;
	readonly createFile: (
		folderId: FolderId,
		relPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<Record<string, never>, CreateFailure>;
	readonly createDirectory: (
		folderId: FolderId,
		relPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<Record<string, never>, CreateFailure>;
	readonly remove: (
		folderId: FolderId,
		relPath: string,
		worktreeId?: WorktreeId | null,
	) => Effect.Effect<Record<string, never>, TreeFailure>;
	readonly readExternal: (
		absPath: string,
	) => Effect.Effect<typeof FsFileContent.Type, ReadExternalFailure>;
	readonly writeExternal: (
		absPath: string,
		content: string,
		expectedMtime: string,
	) => Effect.Effect<{ readonly mtime: string }, WriteExternalFailure>;
}

export class FsService extends Context.Service<FsService, FsServiceShape>()(
	"memoize/FsService",
) {}
