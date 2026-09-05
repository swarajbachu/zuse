import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { FolderId } from "@zuse/contracts";
import { File01Icon } from "@zuse/icons/solid-rounded";
import { useMemo, useState } from "react";
import {
	fileSearchFeedback,
	fileSearchResults,
	searchableFiles,
	searchedFileTarget,
} from "../lib/file-search.ts";
import { useFileTreeResource } from "../lib/file-tree-resource-hooks.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { CommandPaletteDialog } from "./ui/command-palette.tsx";

const close = () => useUiStore.getState().setFileSearchOpen(false);

export function FileSearch() {
	const open = useUiStore((state) => state.fileSearchOpen);
	return open ? <ActiveFileSearch /> : null;
}

function ActiveFileSearch() {
	const context = useActiveContext();
	const projectId = useWorkspaceStore((state) => state.selectedFolderId);
	if (
		context.status !== "ready" ||
		context.worktreePending ||
		projectId === null
	) {
		const message =
			context.status === "empty"
				? "Open a project to search its files."
				: context.status === "cloud-unavailable"
					? "Reconnect this cloud workspace to search its files."
					: "Waiting for the project or worktree to become available…";
		return (
			<FileSearchDialog
				files={[]}
				onClose={close}
				onSelect={() => {}}
				emptyMessage={message}
			/>
		);
	}
	return (
		<ProjectFileSearch
			key={`${context.environmentId}:${context.folderId}:${context.worktreeId}:${context.rootPath}`}
			execution={context}
			projectId={projectId}
		/>
	);
}

function ProjectFileSearch({
	execution,
	projectId,
}: {
	execution: ExecutionRef;
	projectId: FolderId;
}) {
	const view = useFileTreeResource(execution);
	const files = useMemo(
		() => searchableFiles(view.data?.paths ?? []),
		[view.data?.paths],
	);
	return (
		<FileSearchDialog
			files={files}
			onClose={close}
			onSelect={(path) => {
				const ui = useUiStore.getState();
				ui.setView("chat");
				ui.openFileInTab(searchedFileTarget(execution, projectId, path));
			}}
			{...fileSearchFeedback(view)}
		/>
	);
}

export function FileSearchDialog({
	files,
	onClose,
	onSelect,
	emptyMessage,
	notice,
}: {
	files: ReadonlyArray<string>;
	onClose: () => void;
	onSelect: (path: string) => void;
	emptyMessage?: string;
	notice?: string;
}) {
	const [query, setQuery] = useState("");
	const groups = useMemo(
		() => [
			{
				label: "Project files",
				items: fileSearchResults(files, query).map((path) => ({
					id: path,
					value: path,
					label: path.split("/").at(-1) ?? path,
					icon: File01Icon,
					detail: (
						<span className="max-w-[45%] truncate text-xs text-muted-foreground">
							{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
						</span>
					),
				})),
			},
		],
		[files, query],
	);
	return (
		<CommandPaletteDialog
			label="Search project files"
			inputLabel="Search files"
			placeholder="Search files…"
			query={query}
			onQueryChange={setQuery}
			groups={groups}
			onClose={onClose}
			onSelect={onSelect}
			emptyMessage={
				emptyMessage ??
				(query.trim()
					? "No files match your search."
					: "No files in this project.")
			}
			notice={notice}
		/>
	);
}
