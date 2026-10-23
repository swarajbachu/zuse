import { useEffect, useMemo, useState } from "react";
import { bytesForImageContent, imageMimeForFile } from "~/lib/image-preview";
import { readImageFile } from "~/lib/read-image-file";
import { useWorkspaceStore } from "~/store/workspace";
import { useWorktreesStore } from "~/store/worktrees";
import { resolveFileOpenTarget, useFileChipContext } from "./file-chip";

export function useChatImageTarget(src: string | undefined) {
	const { folderId, worktreeId } = useFileChipContext();
	const folderPath = useWorkspaceStore(
		(s) => s.folders.find((f) => f.id === folderId)?.path ?? null,
	);
	const worktreePath = useWorktreesStore((s) =>
		folderId === null
			? null
			: (s.byProject[folderId]?.find((w) => w.id === worktreeId)?.path ?? null),
	);
	return useMemo(() => {
		if (!src || /^(?:https?:)?\/\//i.test(src)) return null;
		let path: string;
		try {
			path = src.toLowerCase().startsWith("file://")
				? decodeURIComponent(new URL(src).pathname)
				: !/^[a-z][a-z0-9+.-]*:/i.test(src)
					? decodeURI(src)
					: "";
		} catch {
			return null;
		}
		return path
			? resolveFileOpenTarget({
					relPath: path,
					folderId,
					worktreeId,
					folderPath,
					worktreePath,
				})
			: null;
	}, [src, folderId, worktreeId, folderPath, worktreePath]);
}

export function useChatImageSource(
	src: string | undefined,
	target: ReturnType<typeof resolveFileOpenTarget>,
) {
	const [preview, setPreview] = useState<{
		target: typeof target;
		url: string;
	} | null>(null);
	const [failedTarget, setFailedTarget] = useState<typeof target>(null);
	useEffect(() => {
		if (!target || (target.kind !== "text" && target.kind !== "external"))
			return;
		let cancelled = false;
		let url: string | null = null;
		void readImageFile(target)
			.then((result) => {
				if (cancelled) return;
				const mime = imageMimeForFile(target.name);
				if (!mime) {
					setFailedTarget(target);
					return;
				}
				url = URL.createObjectURL(
					new Blob([bytesForImageContent(result).slice().buffer], {
						type: mime,
					}),
				);
				setPreview({ target, url });
			})
			.catch(() => {
				if (!cancelled) setFailedTarget(target);
			});
		return () => {
			cancelled = true;
			if (url) URL.revokeObjectURL(url);
		};
	}, [target]);
	return {
		url:
			target === null
				? src
				: preview?.target === target
					? preview.url
					: undefined,
		failed: target !== null && failedTarget === target,
	};
}
