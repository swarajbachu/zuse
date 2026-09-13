import {
	type DragEvent,
	type PointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSidebarProjectLayoutStore } from "../store/sidebar-project-layout.ts";
import { startSidebarPointerDrag } from "./sidebar-pointer-drag.ts";
import {
	materializeSidebarLayout,
	projectGroupIdFor,
	type SidebarDragSource,
	type SidebarDropTarget,
	type SidebarLayoutNode,
	sidebarEmptyGroupAcceptsDrop,
	sidebarGroupItemKey,
	sidebarProjectRowAcceptsDrop,
} from "./sidebar-project-layout.ts";

export type SidebarDropLine = "before" | "after" | "into";

export type SidebarGroupDialog =
	| { readonly kind: "create"; readonly projectKeys: ReadonlyArray<string> }
	| {
			readonly kind: "rename";
			readonly groupId: string;
			readonly name: string;
	  };

const itemKeyOf = (node: SidebarLayoutNode): string =>
	node.kind === "group" ? sidebarGroupItemKey(node.group.id) : node.key;

type Drop = {
	readonly key: string;
	readonly line: SidebarDropLine;
	readonly target: SidebarDropTarget;
};
type DropResolver = (
	source: SidebarDragSource,
	element: HTMLElement,
	clientY: number,
) => Drop | null;

const emptyGroupDropKey = (groupId: string): string => `empty-group:${groupId}`;

export const useSidebarOrganize = (projectKeys: ReadonlyArray<string>) => {
	const layout = useSidebarProjectLayoutStore((s) => s.layout);
	const move = useSidebarProjectLayoutStore((s) => s.move);
	const createGroup = useSidebarProjectLayoutStore((s) => s.createGroup);
	const renameGroup = useSidebarProjectLayoutStore((s) => s.renameGroup);
	const setGroupCollapsed = useSidebarProjectLayoutStore(
		(s) => s.setGroupCollapsed,
	);
	const dissolveGroup = useSidebarProjectLayoutStore((s) => s.dissolveGroup);
	const setGroupIconColor = useSidebarProjectLayoutStore(
		(s) => s.setGroupIconColor,
	);

	const nodes = useMemo(
		() => materializeSidebarLayout(projectKeys, layout),
		[layout, projectKeys],
	);

	const cancelDragRef = useRef<(() => void) | null>(null);
	const dropTargets = useRef(new WeakMap<HTMLElement, DropResolver>());
	useEffect(() => () => cancelDragRef.current?.(), []);
	const [drop, setDrop] = useState<{
		readonly key: string;
		readonly line: SidebarDropLine;
	} | null>(null);
	const [groupDialog, setGroupDialog] = useState<SidebarGroupDialog | null>(
		null,
	);

	const topAfter = (index: number): SidebarDropTarget => {
		const next = nodes[index + 1];
		return next === undefined
			? { kind: "end" }
			: { kind: "before", itemKey: itemKeyOf(next) };
	};

	const clearDrag = (): void => {
		setDrop(null);
	};

	const targetProps = (resolve: DropResolver) => ({
		ref: (element: HTMLElement | null) => {
			if (element !== null) dropTargets.current.set(element, resolve);
		},
	});

	const sourceProps = (source: SidebarDragSource) => ({
		draggable: false,
		onDragStart: (event: DragEvent<HTMLElement>) => event.preventDefault(),
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			if (
				!event.isPrimary ||
				event.button !== 0 ||
				event.pointerType === "touch"
			)
				return;
			const element = event.currentTarget;
			cancelDragRef.current?.();
			const targetAt = (point: {
				clientX: number;
				clientY: number;
			}): Drop | null => {
				let target = element.ownerDocument.elementFromPoint(
					point.clientX,
					point.clientY,
				);
				while (target !== null) {
					if (target instanceof HTMLElement) {
						const resolve = dropTargets.current.get(target);
						if (resolve !== undefined)
							return resolve(source, target, point.clientY);
					}
					target = target.parentElement;
				}
				return null;
			};
			cancelDragRef.current = startSidebarPointerDrag(
				element,
				event.nativeEvent,
				{
					onMove: (point) => {
						const next = targetAt(point);
						setDrop((current) =>
							current?.key === next?.key && current?.line === next?.line
								? current
								: next,
						);
					},
					onDrop: (point) => {
						const next = targetAt(point);
						if (next !== null) move(source, next.target, projectKeys);
					},
					onEnd: clearDrag,
				},
			);
		},
	});

	const projectDragProps = (key: string, groupId: string | null) => {
		const nodeIndex = nodes.findIndex((node) =>
			node.kind === "project"
				? node.key === key
				: node.group.projectKeys.includes(key),
		);
		const node = nodes[nodeIndex];
		const innerIndex =
			node?.kind === "group" ? node.group.projectKeys.indexOf(key) : -1;
		const nextInGroup =
			node?.kind === "group"
				? node.group.projectKeys[innerIndex + 1]
				: undefined;
		const before: SidebarDropTarget =
			groupId === null
				? { kind: "before", itemKey: key }
				: { kind: "group-before", groupId, projectKey: key };
		const after: SidebarDropTarget =
			groupId === null
				? nodeIndex >= 0
					? topAfter(nodeIndex)
					: { kind: "end" }
				: nextInGroup === undefined
					? { kind: "group-end", groupId }
					: {
							kind: "group-before",
							groupId,
							projectKey: nextInGroup,
						};

		return {
			...sourceProps({ kind: "project", key }),
			...targetProps((source, element, clientY) => {
				if (!sidebarProjectRowAcceptsDrop(source, groupId)) return null;
				const rect = element.getBoundingClientRect();
				const line = clientY < rect.top + rect.height / 2 ? "before" : "after";
				return { key, line, target: line === "before" ? before : after };
			}),
		};
	};

	const emptyGroupDropProps = (groupId: string) =>
		targetProps((source) =>
			sidebarEmptyGroupAcceptsDrop(source)
				? {
						key: emptyGroupDropKey(groupId),
						line: "into",
						target: { kind: "group-end", groupId },
					}
				: null,
		);

	const groupDragProps = (id: string) => {
		const itemKey = sidebarGroupItemKey(id);
		const nodeIndex = nodes.findIndex(
			(node) => node.kind === "group" && node.group.id === id,
		);
		return {
			...sourceProps({ kind: "group", id }),
			...targetProps((source, element, clientY) => {
				const rect = element.getBoundingClientRect();
				const y = (clientY - rect.top) / rect.height;
				const line =
					source.kind === "project" && y > 0.28 && y < 0.78
						? "into"
						: y < 0.5
							? "before"
							: "after";
				const target: SidebarDropTarget =
					line === "into"
						? { kind: "group-end", groupId: id }
						: line === "before"
							? { kind: "before", itemKey }
							: nodeIndex >= 0
								? topAfter(nodeIndex)
								: { kind: "end" };
				return { key: itemKey, line, target };
			}),
		};
	};

	const dropLineFor = (key: string): SidebarDropLine | null =>
		drop?.key === key ? drop.line : null;

	return {
		nodes,
		groups: layout.groups,
		dropLineFor,
		projectDragProps,
		groupDragProps,
		emptyGroupDropProps,
		isEmptyGroupDropActive: (groupId: string) =>
			drop?.key === emptyGroupDropKey(groupId) && drop.line === "into",
		inGroupId: (projectKey: string) => projectGroupIdFor(layout, projectKey),
		groupDialog,
		setGroupDialog,
		createGroup: (name: string, keys: ReadonlyArray<string>) => {
			createGroup(
				{ id: crypto.randomUUID(), name, projectKeys: keys },
				projectKeys,
			);
		},
		renameGroup,
		setGroupCollapsed,
		dissolveGroup: (groupId: string) => dissolveGroup(groupId, projectKeys),
		addToGroup: (projectKey: string, groupId: string) => {
			move(
				{ kind: "project", key: projectKey },
				{ kind: "group-end", groupId },
				projectKeys,
			);
		},
		removeFromGroup: (projectKey: string) => {
			move({ kind: "project", key: projectKey }, { kind: "end" }, projectKeys);
		},
		sidebarGroupItemKey,
		setGroupIconColor,
	};
};
