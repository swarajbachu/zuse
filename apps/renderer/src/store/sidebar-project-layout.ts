import type { ProjectIconColorId } from "../lib/sidebar-project-icon.ts";
import {
	createSidebarGroup,
	dissolveSidebarGroup,
	EMPTY_SIDEBAR_PROJECT_LAYOUT,
	moveSidebarItem,
	parseSidebarProjectLayout,
	renameSidebarGroup,
	type SidebarDragSource,
	type SidebarDropTarget,
	type SidebarProjectLayout,
	setSidebarGroupCollapsed,
	setSidebarGroupIconColor,
	snapshotSidebarOrder,
} from "../lib/sidebar-project-layout.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

const STORAGE_KEY = "zuse.sidebar.project-layout.v1";

const readLayout = (): SidebarProjectLayout => {
	if (typeof window === "undefined") return EMPTY_SIDEBAR_PROJECT_LAYOUT;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) return EMPTY_SIDEBAR_PROJECT_LAYOUT;
		return parseSidebarProjectLayout(JSON.parse(raw));
	} catch {
		return EMPTY_SIDEBAR_PROJECT_LAYOUT;
	}
};

const writeLayout = (layout: SidebarProjectLayout): void => {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
	} catch {
		// cache is best-effort
	}
};

type State = {
	readonly layout: SidebarProjectLayout;
	readonly move: (
		source: SidebarDragSource,
		target: SidebarDropTarget,
		projectKeys: ReadonlyArray<string>,
	) => void;
	readonly createGroup: (
		input: {
			readonly id: string;
			readonly name: string;
			readonly projectKeys: ReadonlyArray<string>;
		},
		projectKeys: ReadonlyArray<string>,
	) => void;
	readonly renameGroup: (groupId: string, name: string) => void;
	readonly setGroupCollapsed: (groupId: string, collapsed: boolean) => void;
	readonly dissolveGroup: (
		groupId: string,
		projectKeys: ReadonlyArray<string>,
	) => void;
	readonly setGroupIconColor: (
		groupId: string,
		color: ProjectIconColorId | null,
	) => void;
};

export const useSidebarProjectLayoutStore = create<State>((set, get) => {
	const commit = (
		layout: SidebarProjectLayout,
		projectKeys?: ReadonlyArray<string>,
	): void => {
		const next =
			projectKeys === undefined
				? layout
				: snapshotSidebarOrder(projectKeys, layout);
		writeLayout(next);
		set({ layout: next });
	};
	return {
		layout: readLayout(),
		move: (source, target, projectKeys) => {
			commit(moveSidebarItem(get().layout, source, target), projectKeys);
		},
		createGroup: (input, projectKeys) => {
			commit(createSidebarGroup(get().layout, input), projectKeys);
		},
		renameGroup: (groupId, name) => {
			commit(renameSidebarGroup(get().layout, groupId, name));
		},
		setGroupCollapsed: (groupId, collapsed) => {
			commit(setSidebarGroupCollapsed(get().layout, groupId, collapsed));
		},
		dissolveGroup: (groupId, projectKeys) => {
			commit(dissolveSidebarGroup(get().layout, groupId), projectKeys);
		},
		setGroupIconColor: (groupId, color) => {
			commit(setSidebarGroupIconColor(get().layout, groupId, color));
		},
	};
});
