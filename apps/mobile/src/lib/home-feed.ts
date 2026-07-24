import {
	buildInboxListItems,
	type InboxChatRow,
	type InboxGroupDisplayState,
	type InboxProjectGroup,
} from "./inbox";

export const DEFAULT_RECENT_LIMIT = 5;

export type HomeChatContext = "pinned" | "active" | "recent" | "project";

export type HomeFeedSection = "Pinned" | "Active" | "Recent" | "Projects";

export type HomeFeedItem =
	| {
			type: "section-header";
			key: string;
			title: HomeFeedSection;
	  }
	| {
			type: "chat";
			key: string;
			row: InboxChatRow;
			context: HomeChatContext;
			/** Whether this chat row shows the project identity inline. */
			showProject: boolean;
			isFirst: boolean;
			isLast: boolean;
	  }
	| {
			type: "project-header";
			key: string;
			group: InboxProjectGroup;
			collapsed: boolean;
	  }
	| {
			type: "show-more";
			key: string;
			groupKey: string;
			hiddenCount: number;
			canShowLess: boolean;
	  };

const isActive = (row: InboxChatRow): boolean =>
	row.status === "running" || row.status === "booting";

const byUpdatedAt = (a: InboxChatRow, b: InboxChatRow): number =>
	b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);

const flatSection = (
	title: Exclude<HomeFeedSection, "Projects">,
	context: HomeChatContext,
	rows: readonly InboxChatRow[],
): HomeFeedItem[] => {
	if (rows.length === 0) return [];
	return [
		{ type: "section-header", key: `section:${title}`, title },
		...rows.map(
			(row, index): HomeFeedItem => ({
				type: "chat",
				key: `${context}:${row.key}`,
				row,
				context,
				showProject: true,
				isFirst: index === 0,
				isLast: index === rows.length - 1,
			}),
		),
	];
};

/**
 * Activity-first home feed: Pinned, then Active (running/booting), then the
 * most Recent chats, then the familiar per-project groups. A chat can appear
 * in a flat section *and* its project group — the context-prefixed keys keep
 * React keys unique. Searching collapses everything to the project-grouped
 * result list so matches stay under their project.
 */
export const buildHomeFeed = ({
	groups,
	displayStates,
	searching,
	recentLimit = DEFAULT_RECENT_LIMIT,
}: {
	groups: readonly InboxProjectGroup[];
	displayStates: ReadonlyMap<string, InboxGroupDisplayState>;
	searching: boolean;
	recentLimit?: number;
}): HomeFeedItem[] => {
	const projectItems: HomeFeedItem[] = buildInboxListItems({
		groups,
		displayStates,
		searching,
	}).map((item) => {
		switch (item.type) {
			case "header":
				return {
					type: "project-header",
					key: item.key,
					group: item.group,
					collapsed: item.collapsed,
				};
			case "chat":
				return {
					type: "chat",
					key: `project:${item.key}`,
					row: item.row,
					context: "project",
					showProject: false,
					isFirst: false,
					isLast: item.isLast,
				};
			case "show-more":
				return item;
		}
	});

	if (searching) return projectItems;

	const allRows = groups.flatMap((group) => group.rows);
	const pinned = allRows.filter((row) => row.pinned).sort(byUpdatedAt);
	const active = allRows
		.filter((row) => !row.pinned && isActive(row))
		.sort(byUpdatedAt);
	const recent = allRows
		.filter((row) => !row.pinned && !isActive(row))
		.sort(byUpdatedAt)
		.slice(0, recentLimit);

	const items: HomeFeedItem[] = [
		...flatSection("Pinned", "pinned", pinned),
		...flatSection("Active", "active", active),
		...flatSection("Recent", "recent", recent),
	];
	if (projectItems.length > 0) {
		items.push({
			type: "section-header",
			key: "section:Projects",
			title: "Projects",
		});
		items.push(...projectItems);
	}
	return items;
};
