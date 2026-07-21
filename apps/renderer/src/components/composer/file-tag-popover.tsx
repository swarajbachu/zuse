import type { EditorView } from "@codemirror/view";
import type { FolderId, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "~/components/file-icon";
import { overlayPanelSurface } from "~/components/ui/overlay-surface";
import { type ActiveTrigger, replaceWithChip } from "~/lib/codemirror/composer";
import { getRpcClient } from "~/lib/rpc-client";
import { cn } from "~/lib/utils";

export interface FileTagPopoverProps {
	readonly trigger: ActiveTrigger;
	readonly view: EditorView;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId | null;
	/**
	 * Absolute path of the effective workspace root (project root or, when a
	 * worktree is selected, the worktree path). Used to drop stale results
	 * that race a session switch — anything whose absPath isn't under this
	 * root is silently dropped so the picker never shows files from another
	 * project.
	 */
	readonly workspaceRoot: string | null;
	readonly onClose: () => void;
}

interface SearchHit {
	readonly relPath: string;
	readonly absPath: string;
	readonly kind: "file" | "directory";
}

const basename = (p: string): string => {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
};

const dirname = (p: string): string | null => {
	const i = p.lastIndexOf("/");
	return i === -1 ? null : p.slice(0, i);
};

export function FileTagPopover({
	trigger,
	view,
	projectId,
	worktreeId,
	workspaceRoot,
	onClose,
}: FileTagPopoverProps) {
	const [hits, setHits] = useState<readonly SearchHit[]>([]);
	const [highlight, setHighlight] = useState(0);
	const query = trigger.query;

	// Debounce searches lightly so fast typing doesn't flood the server.
	useEffect(() => {
		let cancelled = false;
		const run = async () => {
			try {
				const client = await getRpcClient();
				const results = await Effect.runPromise(
					client["workspace.searchFiles"]({
						projectId,
						query,
						limit: 20,
						worktreeId,
					}),
				);
				if (cancelled) return;
				// Belt-and-braces: drop any hit whose absPath isn't under the
				// current workspace root. The server already reroots correctly
				// when worktreeId matches, but a race where this effect fires
				// mid-session-switch could otherwise show the previous root's
				// files for a frame.
				const filtered =
					workspaceRoot === null
						? (results as readonly SearchHit[])
						: (results as readonly SearchHit[]).filter((hit) =>
								hit.absPath.startsWith(workspaceRoot),
							);
				setHits(filtered);
				setHighlight(0);
			} catch {
				if (!cancelled) setHits([]);
			}
		};
		const id = window.setTimeout(run, 60);
		return () => {
			cancelled = true;
			window.clearTimeout(id);
		};
	}, [projectId, worktreeId, workspaceRoot, query]);

	const confirm = (hit: SearchHit) => {
		const token = `@${hit.relPath}`;
		replaceWithChip(view, trigger.from, trigger.to, token, {
			kind: "file",
			relPath: hit.relPath,
			absPath: hit.absPath,
			entryKind: hit.kind,
		});
		onClose();
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (hits.length === 0) {
				if (e.key === "Escape") {
					e.preventDefault();
					onClose();
				}
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h + 1) % hits.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				e.stopPropagation();
				setHighlight((h) => (h - 1 + hits.length) % hits.length);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopPropagation();
				const hit = hits[highlight];
				if (hit) confirm(hit);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
		// confirm is stable for `hits[highlight]` reference per render — fine to
		// re-bind on each iteration.
	}, [hits, highlight, onClose]);

	const visible = useMemo(() => hits.slice(0, 12), [hits]);

	if (visible.length === 0) return null;

	return (
		<div
			role="listbox"
			className={cn(
				"absolute bottom-full left-0 z-50 mb-1 w-96 overflow-hidden p-1.5",
				overlayPanelSurface,
			)}
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Files
			</div>
			{visible.map((hit, i) => {
				const active = i === highlight;
				const name = basename(hit.relPath);
				const parent = dirname(hit.relPath);
				return (
					<button
						key={hit.relPath}
						type="button"
						role="option"
						aria-selected={active}
						onMouseEnter={() => setHighlight(i)}
						onClick={() => confirm(hit)}
						className={cn(
							"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
							active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
						)}
					>
						<FileIcon
							name={name}
							kind={hit.kind}
							className="inline-flex size-3.5 shrink-0 items-center justify-center"
						/>
						<span className="truncate font-medium">{name}</span>
						{parent !== null && (
							<span
								className="ml-auto truncate text-xs text-muted-foreground"
								title={hit.relPath}
							>
								{parent}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
