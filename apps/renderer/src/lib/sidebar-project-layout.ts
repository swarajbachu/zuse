/**
 * User-defined sidebar organization: a stable top-level order of projects
 * and named groups. Distinct from `project-groups.ts`, which collapses the
 * same git origin across computers into one logical row.
 *
 * Keys are whatever the sidebar already uses as a row identity (logical
 * group key, or folder id when the catalog is off). Unknown keys are
 * dropped; newly seen projects append.
 */

import {
	isProjectIconColorId,
	type ProjectIconColorId,
} from "./sidebar-project-icon.ts";

export type SidebarProjectGroup = {
	readonly id: string;
	readonly name: string;
	readonly collapsed: boolean;
	readonly projectKeys: ReadonlyArray<string>;
	readonly iconColor?: ProjectIconColorId;
};

export type SidebarProjectLayout = {
	readonly order: ReadonlyArray<string>;
	readonly groups: ReadonlyArray<SidebarProjectGroup>;
};

export const EMPTY_SIDEBAR_PROJECT_LAYOUT: SidebarProjectLayout = {
	order: [],
	groups: [],
};

export const sidebarGroupItemKey = (id: string): string => `group:${id}`;

export const parseSidebarGroupItemKey = (key: string): string | null =>
	key.startsWith("group:") ? key.slice("group:".length) : null;

export type SidebarLayoutNode =
	| { readonly kind: "project"; readonly key: string }
	| { readonly kind: "group"; readonly group: SidebarProjectGroup };

export type SidebarDragSource =
	| { readonly kind: "project"; readonly key: string }
	| { readonly kind: "group"; readonly id: string };

export type SidebarDropTarget =
	| { readonly kind: "before"; readonly itemKey: string }
	| { readonly kind: "end" }
	| {
			readonly kind: "group-before";
			readonly groupId: string;
			readonly projectKey: string;
	  }
	| { readonly kind: "group-end"; readonly groupId: string };

export const sidebarProjectRowAcceptsDrop = (
	source: SidebarDragSource,
	groupId: string | null,
): boolean => source.kind === "project" || groupId === null;

export const sidebarEmptyGroupAcceptsDrop = (
	source: SidebarDragSource,
): boolean => source.kind === "project";

const unique = (keys: ReadonlyArray<string>): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const key of keys) {
		if (key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
};

const groupMap = (
	layout: SidebarProjectLayout,
): Map<string, SidebarProjectGroup> => {
	const map = new Map<string, SidebarProjectGroup>();
	for (const group of layout.groups) map.set(group.id, group);
	return map;
};

const projectGroupId = (
	layout: SidebarProjectLayout,
	projectKey: string,
): string | null => {
	for (const group of layout.groups) {
		if (group.projectKeys.includes(projectKey)) return group.id;
	}
	return null;
};

const removeProject = (
	layout: SidebarProjectLayout,
	projectKey: string,
): SidebarProjectLayout => ({
	...layout,
	order: layout.order.filter((key) => key !== projectKey),
	groups: layout.groups.map((group) => ({
		...group,
		projectKeys: group.projectKeys.filter((key) => key !== projectKey),
	})),
});

const insertBefore = (
	keys: ReadonlyArray<string>,
	item: string,
	before: string | null,
): string[] => {
	const without = keys.filter((key) => key !== item);
	if (before === null) return [...without, item];
	const index = without.indexOf(before);
	if (index < 0) return [...without, item];
	return [...without.slice(0, index), item, ...without.slice(index)];
};

export const materializeSidebarLayout = (
	projectKeys: ReadonlyArray<string>,
	layout: SidebarProjectLayout,
): ReadonlyArray<SidebarLayoutNode> => {
	const known = new Set(projectKeys);
	const used = new Set<string>();
	const groups = new Map<string, SidebarProjectGroup>();
	for (const group of layout.groups) {
		groups.set(group.id, {
			...group,
			projectKeys: unique(group.projectKeys.filter((key) => known.has(key))),
		});
	}

	const nodes: SidebarLayoutNode[] = [];
	const seenGroups = new Set<string>();
	for (const item of layout.order) {
		const groupId = parseSidebarGroupItemKey(item);
		if (groupId !== null) {
			const group = groups.get(groupId);
			if (group === undefined || seenGroups.has(groupId)) continue;
			seenGroups.add(groupId);
			for (const key of group.projectKeys) used.add(key);
			nodes.push({ kind: "group", group });
			continue;
		}
		if (!known.has(item) || used.has(item)) continue;
		used.add(item);
		nodes.push({ kind: "project", key: item });
	}

	for (const group of groups.values()) {
		if (seenGroups.has(group.id)) continue;
		seenGroups.add(group.id);
		for (const key of group.projectKeys) used.add(key);
		nodes.push({ kind: "group", group });
	}

	for (const key of projectKeys) {
		if (used.has(key)) continue;
		nodes.push({ kind: "project", key });
	}

	return nodes;
};

export const createSidebarGroup = (
	layout: SidebarProjectLayout,
	input: {
		readonly id: string;
		readonly name: string;
		readonly projectKeys: ReadonlyArray<string>;
	},
): SidebarProjectLayout => {
	const name = input.name.trim();
	if (name.length === 0) return layout;
	const insertIndexes = input.projectKeys
		.map((key) => layout.order.indexOf(key))
		.filter((index) => index >= 0);
	let next = layout;
	for (const key of input.projectKeys) next = removeProject(next, key);
	const group: SidebarProjectGroup = {
		id: input.id,
		name,
		collapsed: false,
		projectKeys: unique(input.projectKeys),
	};
	const itemKey = sidebarGroupItemKey(group.id);
	const insertAt =
		insertIndexes.length === 0 ? next.order.length : Math.min(...insertIndexes);
	const order = [...next.order];
	order.splice(Math.min(insertAt, order.length), 0, itemKey);
	return {
		...next,
		order: unique(order),
		groups: [...next.groups, group],
	};
};

export const renameSidebarGroup = (
	layout: SidebarProjectLayout,
	groupId: string,
	name: string,
): SidebarProjectLayout => {
	const trimmed = name.trim();
	if (trimmed.length === 0) return layout;
	return {
		...layout,
		groups: layout.groups.map((group) =>
			group.id === groupId ? { ...group, name: trimmed } : group,
		),
	};
};

export const setSidebarGroupCollapsed = (
	layout: SidebarProjectLayout,
	groupId: string,
	collapsed: boolean,
): SidebarProjectLayout => ({
	...layout,
	groups: layout.groups.map((group) =>
		group.id === groupId ? { ...group, collapsed } : group,
	),
});

export const dissolveSidebarGroup = (
	layout: SidebarProjectLayout,
	groupId: string,
): SidebarProjectLayout => {
	const group = groupMap(layout).get(groupId);
	if (group === undefined) return layout;
	const itemKey = sidebarGroupItemKey(groupId);
	const order = layout.order.filter((key) => key !== itemKey);
	const insertAt = layout.order.indexOf(itemKey);
	const nextOrder =
		insertAt < 0
			? [...order, ...group.projectKeys]
			: [
					...order.slice(0, insertAt),
					...group.projectKeys,
					...order.slice(insertAt),
				];
	return {
		...layout,
		order: unique(nextOrder),
		groups: layout.groups.filter((entry) => entry.id !== groupId),
	};
};

export const moveSidebarItem = (
	layout: SidebarProjectLayout,
	source: SidebarDragSource,
	target: SidebarDropTarget,
): SidebarProjectLayout => {
	if (source.kind === "group") {
		if (target.kind === "group-before" || target.kind === "group-end") {
			return layout;
		}
		const itemKey = sidebarGroupItemKey(source.id);
		if (
			!layout.order.includes(itemKey) &&
			!layout.groups.some((g) => g.id === source.id)
		) {
			return layout;
		}
		const before =
			target.kind === "end"
				? null
				: target.itemKey === itemKey
					? null
					: target.itemKey;
		if (target.kind === "before" && target.itemKey === itemKey) return layout;
		return {
			...layout,
			order: insertBefore(layout.order, itemKey, before),
		};
	}

	if (target.kind === "before" && target.itemKey === source.key) return layout;
	if (target.kind === "group-before" && target.projectKey === source.key) {
		return layout;
	}

	const next = removeProject(layout, source.key);

	if (target.kind === "before" || target.kind === "end") {
		const before = target.kind === "end" ? null : target.itemKey;
		return {
			...next,
			order: insertBefore(next.order, source.key, before),
		};
	}

	const group = groupMap(next).get(target.groupId);
	if (group === undefined) return layout;
	const projectKeys =
		target.kind === "group-end"
			? [...group.projectKeys, source.key]
			: insertBefore(group.projectKeys, source.key, target.projectKey);
	return {
		...next,
		groups: next.groups.map((entry) =>
			entry.id === target.groupId ? { ...entry, projectKeys } : entry,
		),
	};
};

export const projectGroupIdFor = projectGroupId;

export const snapshotSidebarOrder = (
	projectKeys: ReadonlyArray<string>,
	layout: SidebarProjectLayout,
): SidebarProjectLayout => {
	const nodes = materializeSidebarLayout(projectKeys, layout);
	return {
		...layout,
		order: nodes.map((node) =>
			node.kind === "group" ? sidebarGroupItemKey(node.group.id) : node.key,
		),
		groups: nodes.flatMap((node) =>
			node.kind === "group" ? [node.group] : [],
		),
	};
};

export const setSidebarGroupIconColor = (
	layout: SidebarProjectLayout,
	groupId: string,
	color: ProjectIconColorId | null,
): SidebarProjectLayout => ({
	...layout,
	groups: layout.groups.map((group) => {
		if (group.id !== groupId) return group;
		if (color === null) {
			const { iconColor: _removed, ...rest } = group;
			return rest;
		}
		return { ...group, iconColor: color };
	}),
});

export const parseSidebarProjectLayout = (
	value: unknown,
): SidebarProjectLayout => {
	if (value === null || typeof value !== "object") {
		return EMPTY_SIDEBAR_PROJECT_LAYOUT;
	}
	const record = value as {
		readonly order?: unknown;
		readonly groups?: unknown;
		readonly iconColors?: unknown;
	};
	const order = Array.isArray(record.order)
		? unique(
				record.order.filter((key): key is string => typeof key === "string"),
			)
		: [];
	const legacyColors: Record<string, ProjectIconColorId> = {};
	if (record.iconColors !== null && typeof record.iconColors === "object") {
		for (const [key, color] of Object.entries(
			record.iconColors as Record<string, unknown>,
		)) {
			if (isProjectIconColorId(color)) legacyColors[key] = color;
		}
	}
	const groups: SidebarProjectGroup[] = [];
	if (Array.isArray(record.groups)) {
		for (const entry of record.groups) {
			if (entry === null || typeof entry !== "object") continue;
			const group = entry as Record<string, unknown>;
			if (typeof group.id !== "string" || group.id.length === 0) continue;
			if (typeof group.name !== "string") continue;
			const projectKeys = Array.isArray(group.projectKeys)
				? unique(
						group.projectKeys.filter(
							(key): key is string => typeof key === "string",
						),
					)
				: [];
			const iconColor = isProjectIconColorId(group.iconColor)
				? group.iconColor
				: (legacyColors[group.id] ?? undefined);
			groups.push({
				id: group.id,
				name: group.name,
				collapsed: group.collapsed === true,
				projectKeys,
				...(iconColor !== undefined ? { iconColor } : {}),
			});
		}
	}
	return { order, groups };
};
