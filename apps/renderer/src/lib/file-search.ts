import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	deriveSurfacePhase,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { FolderId } from "@zuse/contracts";
import fuzzysort from "fuzzysort";
import type { useUiStore } from "../store/ui.ts";

export function fileSearchFeedback(
	view: ResourceView<{ readonly truncated: boolean }>,
): { emptyMessage?: string; notice?: string } {
	const phase = deriveSurfacePhase(view);
	const unavailable =
		phase === "error" ||
		phase === "blocked-auth" ||
		phase === "update-required" ||
		phase === "offline-stale";
	return {
		emptyMessage: unavailable
			? "Project files are unavailable. Check the workspace connection and try again."
			: view.data === null
				? "Loading project files…"
				: undefined,
		notice:
			unavailable && view.data !== null
				? "Connection interrupted. Showing cached files."
				: view.data?.truncated
					? "This project’s file list is partial. Some files may not appear."
					: undefined,
	};
}

export function searchableFiles(paths: ReadonlyArray<string>): string[] {
	return paths
		.filter((path) => !path.endsWith("/"))
		.sort((a, b) => a.localeCompare(b));
}

export function fileSearchResults(
	files: ReadonlyArray<string>,
	query: string,
): ReadonlyArray<string> {
	const search = query.trim();
	return search.length === 0
		? files.slice(0, 100)
		: fuzzysort
				.go(search, files, { limit: 100, threshold: 0.4 })
				.map((result) => result.target);
}

/** Preserve the execution environment and worktree when opening a match. */
export function searchedFileTarget(
	ref: ExecutionRef,
	projectId: FolderId,
	path: string,
): Parameters<ReturnType<typeof useUiStore.getState>["openFileInTab"]>[0] {
	return {
		kind: "text",
		environmentId: ref.environmentId,
		folderId: ref.folderId,
		projectId,
		worktreeId: ref.worktreeId,
		path,
		name: path.split("/").at(-1) ?? path,
	};
}
