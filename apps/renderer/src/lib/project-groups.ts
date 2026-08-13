import type {
	Chat,
	Folder,
	FolderId,
	GitOriginInfo,
	Session,
} from "@zuse/contracts";
import type {
	CatalogConnectionStatus,
	EnvironmentCatalogEntry,
} from "../store/environment-catalog.ts";
import type { EnvironmentShellData } from "./environment-shell-client-bus.ts";

/**
 * Display-only grouping of the environment catalog: the same repository
 * checked out on several computers collapses into ONE logical project row.
 * Computers never form sections — they are a per-member property.
 */
export type LogicalProjectMember = {
	readonly environmentId: string;
	readonly environmentLabel: string;
	readonly connectionKind: EnvironmentCatalogEntry["connectionKind"];
	readonly status: CatalogConnectionStatus;
	readonly folderId: FolderId;
	readonly folderName: string;
	readonly isActive: boolean;
	/** True when this member lives on this physical desktop. */
	readonly local: boolean;
	readonly connected: boolean;
};

export type LogicalChatRef = {
	readonly chat: Chat;
	readonly environmentId: string;
	readonly environmentLabel: string;
	/**
	 * True when the chat lives on a different physical machine than this
	 * desktop. Anchored to the immutable local environment id — it never
	 * changes when the active environment does.
	 */
	readonly remote: boolean;
	/** True when the ref came from the ACTIVE environment's live stores. */
	readonly live: boolean;
	/**
	 * True when any session of this chat is booting/running. Only computed for
	 * catalog refs — active-environment rows derive activity from live stores.
	 */
	readonly busy: boolean;
};

export type LogicalProjectGroup = {
	readonly key: string;
	readonly displayName: string;
	readonly origin: GitOriginInfo | null;
	readonly members: ReadonlyArray<LogicalProjectMember>;
	/** Merged across members, newest `updatedAt` first. Archived chats excluded. */
	readonly chats: ReadonlyArray<LogicalChatRef>;
	readonly environmentPresence: "local-only" | "remote-only" | "mixed";
};

/** Where a NEW chat should run: a member of the selected logical project. */
export type NewChatTarget = {
	readonly environmentId: string;
	/** Null means the computer is selected but this project must be cloned first. */
	readonly folderId: FolderId | null;
};

const originKeyOf = (origin: GitOriginInfo | null): string | null =>
	origin === null ? null : `${origin.host}/${origin.owner}/${origin.repo}`;

const isChatBusy = (chat: Chat, sessions: ReadonlyArray<Session>): boolean =>
	sessions.some(
		(session) =>
			session.chatId === chat.id &&
			(session.status === "booting" || session.status === "running"),
	);

type MutableGroup = {
	key: string;
	origin: GitOriginInfo | null;
	members: LogicalProjectMember[];
	chats: LogicalChatRef[];
	/** Workspace-order index of the first active-env member, if any. */
	activeOrder: number | null;
};

type MemberSource = {
	readonly environmentId: string;
	readonly environmentLabel: string;
	readonly connectionKind: EnvironmentCatalogEntry["connectionKind"];
	readonly status: CatalogConnectionStatus;
	readonly isActive: boolean;
	readonly folder: Folder;
	readonly origin: GitOriginInfo | null;
	readonly chats: ReadonlyArray<Chat>;
	readonly sessions: ReadonlyArray<Session>;
	readonly activeOrder: number | null;
};

export const buildLogicalProjectGroups = (input: {
	readonly entries: ReadonlyArray<EnvironmentCatalogEntry>;
	readonly activeEnvironmentId: string;
	/**
	 * The immutable id of this physical desktop's environment. "Remote"
	 * badges compare against THIS, never the active environment, so the
	 * sidebar reads identically no matter which computer is active.
	 */
	readonly localEnvironmentId: string;
	/** Live workspace-store folders for the ACTIVE environment (catalog may lag). */
	readonly activeFolders: ReadonlyArray<Folder>;
	readonly activeOrigins: Readonly<Record<string, GitOriginInfo | null>>;
	readonly activeChatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>;
	/** Qualified ClientBus shell data; the connection catalog owns no entities. */
	readonly shellsByEnvironment: Readonly<
		Record<string, EnvironmentShellData | null>
	>;
}): ReadonlyArray<LogicalProjectGroup> => {
	const groups: MutableGroup[] = [];
	const groupsByOrigin = new Map<string, MutableGroup[]>();

	const addMember = (source: MemberSource): void => {
		const local = source.environmentId === input.localEnvironmentId;
		const member: LogicalProjectMember = {
			environmentId: source.environmentId,
			environmentLabel: source.environmentLabel,
			connectionKind: source.connectionKind,
			status: source.status,
			folderId: source.folder.id,
			folderName: source.folder.name,
			isActive: source.isActive,
			local,
			connected: source.status === "connected",
		};
		const chatRefs: LogicalChatRef[] = source.chats
			.filter((chat) => chat.archivedAt === null)
			.map((chat) => ({
				chat,
				environmentId: source.environmentId,
				environmentLabel: source.environmentLabel,
				remote: !local,
				live: source.isActive,
				busy: source.isActive ? false : isChatBusy(chat, source.sessions),
			}));
		const originKey = originKeyOf(source.origin);
		if (originKey !== null) {
			const candidates = groupsByOrigin.get(originKey) ?? [];
			// Two checkouts of the same repo on ONE environment stay separate
			// rows — merging is strictly across computers.
			const target = candidates.find(
				(candidate) =>
					!candidate.members.some(
						(existing) => existing.environmentId === source.environmentId,
					),
			);
			if (target !== undefined) {
				target.members.push(member);
				target.chats.push(...chatRefs);
				if (target.activeOrder === null && source.activeOrder !== null) {
					target.activeOrder = source.activeOrder;
				}
				return;
			}
			const created: MutableGroup = {
				key:
					candidates.length === 0
						? originKey
						: `${originKey}\u0001${source.environmentId}:${source.folder.id}`,
				origin: source.origin,
				members: [member],
				chats: chatRefs,
				activeOrder: source.activeOrder,
			};
			candidates.push(created);
			groupsByOrigin.set(originKey, candidates);
			groups.push(created);
			return;
		}
		// Originless folders NEVER merge.
		groups.push({
			key: `${source.environmentId}:${source.folder.id}`,
			origin: null,
			members: [member],
			chats: chatRefs,
			activeOrder: source.activeOrder,
		});
	};

	const activeEntry = input.entries.find(
		(entry) => entry.environmentId === input.activeEnvironmentId,
	);
	// The active environment's data comes from the LIVE stores; its catalog
	// entry only lends connection metadata.
	input.activeFolders.forEach((folder, index) => {
		addMember({
			environmentId: input.activeEnvironmentId,
			environmentLabel: activeEntry?.label ?? "This computer",
			connectionKind: activeEntry?.connectionKind ?? "local",
			status: "connected",
			isActive: true,
			folder,
			origin: input.activeOrigins[folder.id] ?? null,
			chats: input.activeChatsByProject[folder.id] ?? [],
			sessions: [],
			activeOrder: index,
		});
	});
	for (const entry of input.entries) {
		if (entry.environmentId === input.activeEnvironmentId) continue;
		const shell = input.shellsByEnvironment[entry.environmentId];
		if (shell === null || shell === undefined) continue;
		for (const folder of shell.folders) {
			addMember({
				environmentId: entry.environmentId,
				environmentLabel: entry.label,
				connectionKind: entry.connectionKind,
				status: entry.status,
				isActive: false,
				folder,
				origin: shell.originsByFolder[folder.id] ?? null,
				chats: shell.chatsByProject[folder.id] ?? [],
				sessions: shell.sessionsByProject[folder.id] ?? [],
				activeOrder: null,
			});
		}
	}

	const finished = groups.map((group): LogicalProjectGroup => {
		const members = [...group.members].sort(
			(left, right) =>
				Number(right.isActive) - Number(left.isActive) ||
				Number(right.connected) - Number(left.connected),
		);
		const activeMember = members.find((member) => member.isActive);
		const displayName =
			activeMember?.folderName ??
			members.find((member) => member.connected)?.folderName ??
			members[0]?.folderName ??
			"";
		const localCount = members.filter((member) => member.local).length;
		return {
			key: group.key,
			displayName,
			origin: group.origin,
			members,
			chats: [...group.chats].sort(
				(left, right) =>
					right.chat.updatedAt.getTime() - left.chat.updatedAt.getTime(),
			),
			environmentPresence:
				localCount === members.length
					? "local-only"
					: localCount === 0
						? "remote-only"
						: "mixed",
		};
	});

	// Groups anchored in the active workspace keep its order; the rest follow
	// alphabetically so remote-only repos have a stable, scannable position.
	return finished
		.map((group, index) => ({
			group,
			order: groups[index]?.activeOrder ?? null,
		}))
		.sort((left, right) => {
			if (left.order !== null && right.order !== null)
				return left.order - right.order;
			if (left.order !== null) return -1;
			if (right.order !== null) return 1;
			return left.group.displayName.localeCompare(right.group.displayName);
		})
		.map(({ group }) => group);
};

/**
 * The member a plain "open this project" action should land on: the active
 * environment first, then the first connected computer.
 */
export const preferredGroupMember = (
	group: LogicalProjectGroup,
): LogicalProjectMember | null =>
	group.members.find((member) => member.isActive) ??
	group.members.find((member) => member.connected) ??
	null;

/**
 * Where a new chat runs unless the user picks otherwise: this desktop's
 * member of the group when present, else the first connected member.
 */
export const defaultNewChatTarget = (
	group: LogicalProjectGroup,
): NewChatTarget | null => {
	const member =
		group.members.find((candidate) => candidate.local) ??
		group.members.find((candidate) => candidate.connected) ??
		null;
	return member === null
		? null
		: { environmentId: member.environmentId, folderId: member.folderId };
};

export type ComputerPickerItem = {
	readonly environmentId: string;
	readonly folderId: FolderId | null;
	readonly label: string;
	readonly status: CatalogConnectionStatus;
	readonly projectAvailable: boolean;
	readonly setupAvailable: boolean;
	readonly retryable: boolean;
	readonly selected: boolean;
	readonly disabled: boolean;
};

export type ComputerPickerModel =
	| { readonly kind: "hidden"; readonly item: ComputerPickerItem }
	| { readonly kind: "static"; readonly item: ComputerPickerItem }
	| {
			readonly kind: "menu";
			readonly items: ReadonlyArray<ComputerPickerItem>;
	  };

/**
 * "Run on" options for a logical project group. Selection reflects the
 * draft's target only — picking never touches global state. Hidden when
 * there is nothing to choose (single member on this desktop); a
 * non-interactive static label when the only member is remote; otherwise a
 * menu with this desktop first and non-connected members disabled.
 */
export const computerPickerItems = (
	group: LogicalProjectGroup,
	target: NewChatTarget | null,
	entries: ReadonlyArray<EnvironmentCatalogEntry> = [],
): ComputerPickerModel => {
	const resolved = target ?? defaultNewChatTarget(group);
	const memberItems = [...group.members]
		.sort(
			(left, right) =>
				Number(right.local) - Number(left.local) ||
				Number(right.connected) - Number(left.connected),
		)
		.map(
			(member): ComputerPickerItem => ({
				environmentId: member.environmentId,
				folderId: member.folderId,
				label:
					member.connectionKind === "local"
						? "This computer"
						: member.environmentLabel,
				status: member.status,
				projectAvailable: true,
				setupAvailable: false,
				retryable: member.status === "error" || member.status === "offline",
				selected:
					resolved !== null &&
					member.environmentId === resolved.environmentId &&
					member.folderId === resolved.folderId,
				disabled:
					!member.connected &&
					member.status !== "error" &&
					member.status !== "offline",
			}),
		);
	const representedEnvironmentIds = new Set(
		memberItems.map((item) => item.environmentId),
	);
	const catalogItems = entries
		.filter(
			(entry) =>
				entry.connectionKind !== "local" &&
				!representedEnvironmentIds.has(entry.environmentId),
		)
		.map(
			(entry): ComputerPickerItem => ({
				environmentId: entry.environmentId,
				folderId: null,
				label: entry.label,
				status: entry.status,
				projectAvailable: false,
				setupAvailable:
					entry.status === "connected" && group.origin?.cloneUrl !== undefined,
				retryable: entry.status === "error" || entry.status === "offline",
				selected:
					resolved?.environmentId === entry.environmentId &&
					resolved.folderId === null,
				disabled:
					entry.status === "connecting" ||
					(entry.status === "connected" &&
						group.origin?.cloneUrl === undefined),
			}),
		)
		.sort(
			(left, right) =>
				Number(right.retryable) - Number(left.retryable) ||
				left.label.localeCompare(right.label),
		);
	const items = [...memberItems, ...catalogItems];
	const only = items.length === 1 ? items[0] : undefined;
	if (only !== undefined) {
		if (only.retryable) return { kind: "menu", items };
		return group.members[0]?.local
			? { kind: "hidden", item: only }
			: { kind: "static", item: only };
	}
	return { kind: "menu", items };
};
