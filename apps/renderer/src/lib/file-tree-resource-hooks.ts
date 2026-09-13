import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
	fileTreeResourceKey,
	fileTreeResourceSnapshot,
	retainFileTreeResource,
	subscribeFileTreeResource,
} from "./file-tree-client-bus.ts";

/** File tree and file search retain the same qualified, live resource. */
export function useFileTreeResource({
	environmentId,
	folderId,
	worktreeId,
	rootPath,
}: ExecutionRef) {
	const key = useMemo(
		() =>
			fileTreeResourceKey({ environmentId, folderId, worktreeId, rootPath }),
		[environmentId, folderId, rootPath, worktreeId],
	);
	useEffect(() => {
		const retained = retainFileTreeResource(key);
		return () => retained.lease.release();
	}, [key]);
	return useSyncExternalStore(
		(listener) => subscribeFileTreeResource(key, listener),
		() => fileTreeResourceSnapshot(key),
		() => fileTreeResourceSnapshot(key),
	);
}
