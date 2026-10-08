import { workspaceScopeKey } from "@zuse/client-runtime/environment-scope";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	type Folder,
	PERSONAL_WORKSPACE_KEY,
	type WorkspaceScope,
} from "@zuse/contracts";
import type { EnvironmentShellData } from "./environment-shell-client-bus.ts";
import { rendererWorkspaceSnapshot } from "./renderer-workspace.ts";
import { isDesktopLocalEnvironment } from "./rpc-client.ts";

/** Projects from servers that predate workspace ownership are Personal. */
export const folderWorkspaceKey = (folder: Folder): string =>
	folder.workspaceKey ?? PERSONAL_WORKSPACE_KEY;

/**
 * Owner recorded for a project added to `environmentId` right now. Only this
 * desktop's server records owners; remote machines stay Personal.
 */
export const newProjectWorkspaceKey = (
	environmentId: string,
): string | undefined =>
	isDesktopLocalEnvironment(environmentId)
		? rendererWorkspaceSnapshot().key
		: undefined;

const pick = <Value>(
	record: Readonly<Record<string, Value>>,
	ids: ReadonlySet<string>,
): Readonly<Record<string, Value>> =>
	Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));

/**
 * The desktop's own server holds projects for every workspace. Keep only the
 * selected workspace's projects, and the chats, sessions and origins under
 * them. Every other environment already belongs to exactly one workspace.
 */
export const scopeEnvironmentShell = (
	environmentId: string,
	data: EnvironmentShellData,
	scope: WorkspaceScope,
): EnvironmentShellData => {
	if (!isDesktopLocalEnvironment(environmentId)) return data;
	const key = workspaceScopeKey(scope);
	if (data.folders.every((folder) => folderWorkspaceKey(folder) === key))
		return data;
	const folders = data.folders.filter(
		(folder) => folderWorkspaceKey(folder) === key,
	);
	const ids = new Set<string>(folders.map((folder) => folder.id));
	return {
		folders,
		originsByFolder: pick(data.originsByFolder, ids),
		chatsByProject: pick(data.chatsByProject, ids),
		sessionsByProject: pick(data.sessionsByProject, ids),
		creationOperationsByProject: pick(data.creationOperationsByProject, ids),
	};
};

// Scoped views must keep their identity between reads so
// `useSyncExternalStore` selectors do not re-render on every call.
const scopedViews = new WeakMap<
	ResourceView<EnvironmentShellData>,
	Map<string, ResourceView<EnvironmentShellData>>
>();

export const scopeEnvironmentShellView = (
	environmentId: string,
	view: ResourceView<EnvironmentShellData>,
	scope: WorkspaceScope,
): ResourceView<EnvironmentShellData> => {
	if (view.data === null || !isDesktopLocalEnvironment(environmentId))
		return view;
	const key = workspaceScopeKey(scope);
	let byScope = scopedViews.get(view);
	const cached = byScope?.get(key);
	if (cached !== undefined) return cached;
	const data = scopeEnvironmentShell(environmentId, view.data, scope);
	const scoped = data === view.data ? view : { ...view, data };
	if (byScope === undefined) {
		byScope = new Map();
		scopedViews.set(view, byScope);
	}
	byScope.set(key, scoped);
	return scoped;
};
