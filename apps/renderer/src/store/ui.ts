import {
	type ChatRef,
	resourceRefKey,
} from "@zuse/client-runtime/resource-ref";
import {
	ChatId,
	type CodeAnnotation,
	EnvironmentId,
	type FolderId,
	type PtyId,
	type WorktreeId,
} from "@zuse/contracts";
import {
	defaultFileViewForName,
	isPreviewableFileName,
} from "~/lib/file-preview";
import { requestCloudSettingsLeave } from "../lib/cloud-settings-guard.ts";
import { requestReviewLeave } from "../lib/review-edit-guard.ts";
import { currentReviewTabScope } from "../lib/review-tab-scope.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

export { isPreviewableFileName } from "~/lib/file-preview";

/**
 * Top-level renderer view. The settings page replaces the chat surface in the
 * main pane so users have a real settings page rather than a slide-in drawer.
 */
export type View = "chat" | "settings";

/**
 * Which sub-surface of the settings page is active. `general` / `providers` /
 * `workspace` are global; a `repository` section pins to a specific project
 * so its overrides + worktree list render in the right pane.
 */
export type SettingsSection =
	| { readonly kind: "general" }
	| { readonly kind: "defaults" }
	| { readonly kind: "providers" }
	| { readonly kind: "plugins"; readonly tab?: PluginsSettingsTab }
	| { readonly kind: "devices" }
	| { readonly kind: "organizations" }
	| { readonly kind: "machines" }
	| {
			readonly kind: "cloud";
			readonly page:
				| "repositories"
				| "image"
				| "agents"
				| "billing"
				| "sharing";
	  }
	| { readonly kind: "browser" }
	| { readonly kind: "simulator" }
	| { readonly kind: "pokedex" }
	| { readonly kind: "diagnostics" }
	| { readonly kind: "shortcuts" }
	| { readonly kind: "experimental" }
	| { readonly kind: "repository"; readonly projectId: FolderId };

/**
 * Which surface the main pane is showing. The chat tab is always available;
 * the file tab only exists when `openFile !== null`. Opening a different file
 * replaces (never stacks) the file tab — see specs/0.02-MVP/features/file-viewer.md.
 */
export type PluginsSettingsTab = "plugins" | "skills";

export type MainTab =
	| "chat"
	| "file"
	| "changes"
	| "archives"
	| "usage"
	| "plugins";

/**
 * Whether the Usage dashboard shows every project's usage (`global`, opened
 * from the sidebar footer) or just the selected project's usage across all its
 * sessions (`project`, opened from a project's context menu).
 */
export type UsageScope = "global" | "project";

/**
 * Panel kinds the right-hand dock can host. The dock is user-managed: panels
 * are added from a launcher / "+" menu and closed individually, rather than
 * being a fixed tab set.
 */
export type PanelKind =
	| "files"
	| "terminal"
	| "changes"
	| "pr"
	| "plan"
	| "browser"
	| "device"
	| "subagents";

/**
 * Kinds that may have at most one open instance. Terminal is the only
 * multi-instance kind — each terminal is its own dock tab.
 */
export const SINGLETON_PANEL_KINDS: ReadonlySet<PanelKind> = new Set([
	"files",
	"changes",
	"pr",
	"plan",
	"browser",
	"subagents",
]);

/**
 * A panel tab in the right dock. `id` is a stable per-tab key used to
 * activate/close it. Terminal panels also carry a chat-relative `slot`
 * (0-based) that resolves to the owning chat's Nth terminal instance at
 * render time — see `terminals.ts` `ensureSlot`. The dock layout is per
 * sidebar-chat (`rightPanelsByChat`), so each chat keeps its own set of open
 * tabs and terminals; the singletons are context-aware internally.
 */
export type PanelInstance =
	| { readonly id: string; readonly kind: "files" }
	| { readonly id: string; readonly kind: "changes" }
	| { readonly id: string; readonly kind: "pr" }
	| { readonly id: string; readonly kind: "plan" }
	| { readonly id: string; readonly kind: "browser" }
	| {
			readonly id: string;
			readonly kind: "device";
			readonly deviceId?: string;
	  }
	| { readonly id: string; readonly kind: "subagents" }
	| { readonly id: string; readonly kind: "terminal"; readonly slot: number };

/**
 * Which body the file viewer is showing. `edit` is the CodeMirror editor;
 * `diff` is the side-by-side patch view (working tree vs HEAD); `preview`
 * renders saved markdown / HTML files. Toggled in the toolbar; defaults set
 * per entry point.
 */
export type FileView = "edit" | "diff" | "preview";

const coerceFileView = (
	file: { readonly kind: "text" | "external"; readonly name: string },
	view: FileView,
): FileView => {
	if (file.kind === "external" && view === "diff") return "edit";
	if (view === "preview" && !isPreviewableFileName(file.name)) return "edit";
	return view;
};

/**
 * Discriminated by `kind`. `text` is the project-root-relative path the file
 * editor reads via `fs.readFile`; `image` is a raw URL the renderer renders
 * inline (currently used for `zuse://attachments/<id>` so screenshots
 * stay inside the app instead of bouncing to the OS handler).
 */
export type OpenFile =
	| {
			readonly kind: "text";
			readonly folderId: FolderId;
			/** Logical project that owns the file when folderId is a remote checkout. */
			readonly projectId?: FolderId;
			/** Explicit RPC environment for remote/cloud file operations. */
			readonly environmentId?: string;
			readonly path: string;
			readonly name: string;
			/**
			 * Worktree the file lives in. Persisted on the OpenFile so a save
			 * still targets the right tree even if the user switches selected
			 * sessions while the file is open. `null` means main checkout.
			 */
			readonly worktreeId: WorktreeId | null;
			readonly view: FileView;
	  }
	| {
			readonly kind: "image";
			readonly src: string;
			readonly name: string;
	  }
	| {
			/**
			 * A file outside any project folder (e.g. a plan or markdown file the
			 * agent wrote elsewhere on disk). Read/written by absolute path via the
			 * `fs.*ExternalFile` RPCs, which deliberately skip the workspace
			 * sandbox. External files are edit/preview only — there's no git/folder
			 * context for a diff.
			 */
			readonly kind: "external";
			readonly absPath: string;
			readonly name: string;
			readonly view: FileView;
	  };

export const openFileBelongsToProject = (
	openFile: Extract<OpenFile, { kind: "text" }>,
	selectedProjectId: FolderId | null,
): boolean =>
	selectedProjectId !== null &&
	(openFile.projectId ?? openFile.folderId) === selectedProjectId;

export type RevealedAnnotation = CodeAnnotation & {
	/**
	 * Monotonic token so clicking the same annotation again still re-scrolls and
	 * refreshes the editor highlight.
	 */
	readonly revealToken: number;
};

export type ReviewNavigation = {
	readonly path: string | null;
	readonly line: number | null;
	readonly side: "additions" | "deletions" | null;
	readonly token: number;
};

type UiState = {
	readonly view: View;
	readonly setView: (view: View) => void;
	readonly settingsSection: SettingsSection;
	readonly fileSearchOpen: boolean;
	readonly setFileSearchOpen: (open: boolean) => void;
	readonly setSettingsSection: (section: SettingsSection) => void;
	readonly activeMainTab: MainTab;
	readonly usageScope: UsageScope;
	readonly openFile: OpenFile | null;
	readonly changesTabOpen: boolean;
	readonly reviewTabScope: string | null;
	readonly reviewNavigation: ReviewNavigation | null;
	readonly fileDirty: boolean;

	readonly autosave: boolean;
	readonly leftSidebarOpen: boolean;

	readonly leftSidebarPeek: boolean;

	readonly rightPaneLayoutByChat: Record<string, RightPaneLayout>;

	readonly bottomTerminalLayoutByChat: Record<string, BottomTerminalLayout>;

	readonly chatSwitcherOpen: boolean;
	readonly isFullScreen: boolean;

	readonly environmentSummaryOpen: boolean;

	readonly changesListMode: ChangesListMode;

	readonly rightPanelsByChat: Record<string, ReadonlyArray<PanelInstance>>;
	readonly activeRightPanelByChat: Record<string, string | null>;
	readonly selectedSubagentByChat: Record<string, string | null>;
	readonly revealedAnnotation: RevealedAnnotation | null;
	readonly setActiveMainTab: (tab: MainTab) => void;

	readonly openUsage: (scope: UsageScope) => void;
	readonly openFileInTab: (
		file:
			| (Omit<Extract<OpenFile, { kind: "text" }>, "view"> & {
					view?: FileView;
			  })
			| (Omit<Extract<OpenFile, { kind: "external" }>, "view"> & {
					view?: FileView;
			  })
			| Extract<OpenFile, { kind: "image" }>,
	) => void;
	readonly setOpenFileView: (view: FileView) => void;
	readonly closeFileTab: () => void;
	readonly openChanges: (
		path?: string | null,
		line?: number | null,
		side?: "additions" | "deletions" | null,
	) => void;
	readonly closeChangesTab: () => void;
	readonly setFileDirty: (dirty: boolean) => void;
	readonly setLeftSidebarOpen: (open: boolean) => void;
	readonly setLeftSidebarPeek: (peek: boolean) => void;

	readonly setRightSidebarOpenForChat: (ref: ChatRef, open: boolean) => void;
	readonly setRightSidebarWidthForChat: (
		ref: ChatRef,
		widthPercent: number,
	) => void;
	readonly setBottomTerminalOpenForChat: (ref: ChatRef, open: boolean) => void;
	readonly setBottomTerminalHeightForChat: (
		ref: ChatRef,
		heightPx: number,
	) => void;
	readonly setActiveBottomTerminalForChat: (
		ref: ChatRef,
		terminalId: PtyId | null,
	) => void;
	readonly setChatSwitcherOpen: (open: boolean) => void;
	readonly toggleChatSwitcher: () => void;
	readonly setFullScreen: (full: boolean) => void;
	readonly setEnvironmentSummaryOpen: (open: boolean) => void;
	readonly toggleEnvironmentSummary: () => void;
	readonly setChangesListMode: (mode: ChangesListMode) => void;

	readonly addPanel: (ref: ChatRef, kind: PanelKind) => void;
	readonly openDevicePanel: (
		ref: ChatRef,
		deviceId: string,
		panelId?: string,
	) => void;
	/** Return a simulator tab to its picker; the simulator session keeps running. */
	readonly showDevicePicker: (ref: ChatRef, panelId: string) => void;
	readonly addTerminalPanelForSlot: (ref: ChatRef, slot: number) => void;

	readonly closePanel: (ref: ChatRef, id: string) => void;

	readonly reconcileTerminalPanelSlots: (
		ref: ChatRef,
		removedSlots: ReadonlyArray<number>,
	) => void;
	readonly setActiveRightPanel: (ref: ChatRef, id: string) => void;

	readonly clearChatPanels: (ref: ChatRef) => void;

	readonly revealPanelForChat: (ref: ChatRef, kind: PanelKind) => void;
	readonly revealSubagent: (ref: ChatRef, childSessionId: string) => void;
	readonly selectSubagent: (
		ref: ChatRef,
		childSessionId: string | null,
	) => void;
	readonly revealAnnotation: (annotation: CodeAnnotation) => void;
	readonly clearRevealedAnnotation: () => void;
};

const newPanelId = (): string =>
	globalThis.crypto?.randomUUID?.() ??
	`p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const ENVIRONMENT_SUMMARY_STORAGE_KEY =
	"zuse.environmentSummary.open.v1";
export const CHANGES_LIST_MODE_STORAGE_KEY = "zuse.changes.listMode.v1";
export type ChangesListMode = "list" | "tree";

export const RIGHT_PANE_WIDTHS_STORAGE_KEY = "zuse.rightPane.widths.v2";
export const DEFAULT_RIGHT_PANE_WIDTH_PERCENT = 22;
export const BOTTOM_TERMINAL_HEIGHTS_STORAGE_KEY =
	"zuse.bottomTerminal.heights.v1";
export const DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX = 260;

export type RightPaneLayout = {
	readonly open: boolean;
	readonly widthPercent: number;
};

export type BottomTerminalLayout = {
	readonly open: boolean;
	readonly heightPx: number;
	readonly activeTerminalId: PtyId | null;
};

export const closedBottomTerminalLayout = (
	heightPx = DEFAULT_BOTTOM_TERMINAL_HEIGHT_PX,
): BottomTerminalLayout => ({
	open: false,
	heightPx,
	activeTerminalId: null,
});

export const closedRightPaneLayout = (
	widthPercent = DEFAULT_RIGHT_PANE_WIDTH_PERCENT,
): RightPaneLayout => ({ open: false, widthPercent });

export const rightPaneKey = (ref: ChatRef): string => resourceRefKey(ref);

/** Decode only keys produced by `rightPaneKey`; malformed persisted input is ignored. */
export const rightPaneRefFromKey = (key: string): ChatRef | null => {
	const [kind, encodedEnvironment, encodedChat, ...extra] = key.split(":");
	if (
		kind !== "chat" ||
		encodedEnvironment === undefined ||
		encodedChat === undefined ||
		extra.length > 0
	) {
		return null;
	}
	try {
		return {
			environmentId: EnvironmentId.make(decodeURIComponent(encodedEnvironment)),
			chatId: ChatId.make(decodeURIComponent(encodedChat)),
		};
	} catch {
		return null;
	}
};

export const rightPaneLayoutForChat = (
	state: Pick<UiState, "rightPaneLayoutByChat">,
	ref: ChatRef | null,
): RightPaneLayout =>
	ref === null
		? closedRightPaneLayout()
		: (state.rightPaneLayoutByChat[rightPaneKey(ref)] ??
			closedRightPaneLayout());

export const bottomTerminalLayoutForChat = (
	state: Pick<UiState, "bottomTerminalLayoutByChat">,
	ref: ChatRef | null,
): BottomTerminalLayout =>
	ref === null
		? closedBottomTerminalLayout()
		: (state.bottomTerminalLayoutByChat[rightPaneKey(ref)] ??
			closedBottomTerminalLayout());

const initialEnvironmentSummaryOpen = (): boolean => {
	if (typeof window === "undefined") return true;
	try {
		return (
			window.localStorage.getItem(ENVIRONMENT_SUMMARY_STORAGE_KEY) !== "false"
		);
	} catch {
		return true;
	}
};

const persistEnvironmentSummaryOpen = (open: boolean): void => {
	try {
		window.localStorage.setItem(ENVIRONMENT_SUMMARY_STORAGE_KEY, String(open));
	} catch {}
};

const initialChangesListMode = (): ChangesListMode => {
	if (typeof window === "undefined") return "list";
	try {
		return window.localStorage.getItem(CHANGES_LIST_MODE_STORAGE_KEY) === "tree"
			? "tree"
			: "list";
	} catch {
		return "list";
	}
};

const persistChangesListMode = (mode: ChangesListMode): void => {
	try {
		window.localStorage.setItem(CHANGES_LIST_MODE_STORAGE_KEY, mode);
	} catch {}
};

const initialRightPaneWidths = (): Record<string, number> => {
	if (typeof window === "undefined") return {};
	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(RIGHT_PANE_WIDTHS_STORAGE_KEY) ?? "{}",
		) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, number] =>
					typeof entry[1] === "number" &&
					Number.isFinite(entry[1]) &&
					entry[1] > 0 &&
					entry[1] <= 100,
			),
		);
	} catch {
		return {};
	}
};

const initialRightPaneLayout = (): Record<string, RightPaneLayout> =>
	Object.fromEntries(
		Object.entries(initialRightPaneWidths()).map(([chatId, widthPercent]) => [
			chatId,
			closedRightPaneLayout(widthPercent),
		]),
	);

const initialBottomTerminalHeights = (): Record<string, number> => {
	if (typeof window === "undefined") return {};
	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(BOTTOM_TERMINAL_HEIGHTS_STORAGE_KEY) ?? "{}",
		) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, number] =>
					typeof entry[1] === "number" &&
					Number.isFinite(entry[1]) &&
					entry[1] > 0,
			),
		);
	} catch {
		return {};
	}
};

const initialBottomTerminalLayout = (): Record<string, BottomTerminalLayout> =>
	Object.fromEntries(
		Object.entries(initialBottomTerminalHeights()).map(([key, heightPx]) => [
			key,
			closedBottomTerminalLayout(heightPx),
		]),
	);

const persistRightPaneWidths = (
	layoutByChat: Record<string, RightPaneLayout>,
): void => {
	try {
		window.localStorage.setItem(
			RIGHT_PANE_WIDTHS_STORAGE_KEY,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(layoutByChat).map(([chatId, layout]) => [
						chatId,
						layout.widthPercent,
					]),
				),
			),
		);
	} catch {}
};

const persistBottomTerminalHeights = (
	layoutByChat: Record<string, BottomTerminalLayout>,
): void => {
	try {
		window.localStorage.setItem(
			BOTTOM_TERMINAL_HEIGHTS_STORAGE_KEY,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(layoutByChat).map(([key, layout]) => [
						key,
						layout.heightPx,
					]),
				),
			),
		);
	} catch {}
};

const reindexTerminalSlots = (
	panels: ReadonlyArray<PanelInstance>,
): ReadonlyArray<PanelInstance> => {
	let next = 0;
	return panels.map((p) =>
		p.kind === "terminal" ? { ...p, slot: next++ } : p,
	);
};

/** Stable empty reference so `rightPanelsByChat[rightPaneKey(ref)] ?? EMPTY_PANELS`
 * doesn't churn selectors for chats with no dock layout yet. */
export const EMPTY_PANELS: ReadonlyArray<PanelInstance> = [];

const writePanels = (
	state: UiState,
	key: string,
	panels: ReadonlyArray<PanelInstance>,
	activeId: string | null,
): Pick<UiState, "rightPanelsByChat" | "activeRightPanelByChat"> => ({
	rightPanelsByChat: { ...state.rightPanelsByChat, [key]: panels },
	activeRightPanelByChat: {
		...state.activeRightPanelByChat,
		[key]: activeId,
	},
});

export const useUiStore = create<UiState>((set, get) => ({
	view: "chat",
	setView: (view) => {
		if (
			get().view === "settings" &&
			get().settingsSection.kind === "machines" &&
			view !== "settings" &&
			!requestCloudSettingsLeave()
		)
			return;
		set({ view });
	},
	settingsSection: { kind: "general" },
	fileSearchOpen: false,
	setFileSearchOpen: (fileSearchOpen) =>
		set(
			fileSearchOpen
				? { fileSearchOpen, chatSwitcherOpen: false }
				: { fileSearchOpen },
		),
	setSettingsSection: (section) => {
		if (
			get().view === "settings" &&
			get().settingsSection.kind === "machines" &&
			section.kind !== "machines" &&
			!requestCloudSettingsLeave()
		)
			return;
		set({ settingsSection: section });
	},
	activeMainTab: "chat",
	usageScope: "global",
	openFile: null,
	changesTabOpen: false,
	reviewTabScope: null,
	reviewNavigation: null,
	fileDirty: false,
	autosave: false,
	leftSidebarOpen: true,
	leftSidebarPeek: false,
	rightPaneLayoutByChat: initialRightPaneLayout(),
	bottomTerminalLayoutByChat: initialBottomTerminalLayout(),
	chatSwitcherOpen: false,
	isFullScreen: false,
	environmentSummaryOpen: initialEnvironmentSummaryOpen(),
	changesListMode: initialChangesListMode(),
	rightPanelsByChat: {},
	activeRightPanelByChat: {},
	selectedSubagentByChat: {},
	revealedAnnotation: null,
	setActiveMainTab: (tab) => {
		if (get().activeMainTab === "changes" && tab !== "changes") {
			requestReviewLeave(() => set({ activeMainTab: tab }));
			return;
		}
		set({ activeMainTab: tab });
	},
	openUsage: (scope) =>
		set({ view: "chat", activeMainTab: "usage", usageScope: scope }),
	openFileInTab: (file) => {
		const open = () =>
			set({
				openFile:
					file.kind === "image"
						? file
						: {
								...file,
								view: coerceFileView(
									file,
									file.view ?? defaultFileViewForName(file.name),
								),
							},
				activeMainTab: "file",
				fileDirty: false,
			});
		if (get().activeMainTab === "changes") {
			requestReviewLeave(open);
			return;
		}
		open();
	},
	setOpenFileView: (view) =>
		set((s) => {
			if (
				s.openFile === null ||
				(s.openFile.kind !== "text" && s.openFile.kind !== "external")
			) {
				return s;
			}
			return {
				openFile: { ...s.openFile, view: coerceFileView(s.openFile, view) },
			};
		}),
	closeFileTab: () =>
		set({ openFile: null, activeMainTab: "chat", fileDirty: false }),
	openChanges: (path = null, line = null, side = null) =>
		set((state) => ({
			view: "chat",
			changesTabOpen: true,
			reviewTabScope: currentReviewTabScope(),
			activeMainTab: "changes",
			reviewNavigation: {
				path,
				line,
				side,
				token: (state.reviewNavigation?.token ?? 0) + 1,
			},
		})),
	closeChangesTab: () =>
		requestReviewLeave(() =>
			set({
				changesTabOpen: false,
				reviewTabScope: null,
				activeMainTab: "chat",
				reviewNavigation: null,
			}),
		),
	setFileDirty: (dirty) => set({ fileDirty: dirty }),

	setLeftSidebarOpen: (open) =>
		set({ leftSidebarOpen: open, leftSidebarPeek: false }),
	setLeftSidebarPeek: (peek) => set({ leftSidebarPeek: peek }),
	setRightSidebarOpenForChat: (ref, open) =>
		set((s) => {
			const key = rightPaneKey(ref);
			return {
				rightPaneLayoutByChat: {
					...s.rightPaneLayoutByChat,
					[key]: {
						...(s.rightPaneLayoutByChat[key] ?? closedRightPaneLayout()),
						open,
					},
				},
			};
		}),
	setRightSidebarWidthForChat: (ref, widthPercent) =>
		set((s) => {
			if (!Number.isFinite(widthPercent) || widthPercent <= 0) return s;
			const key = rightPaneKey(ref);
			const rightPaneLayoutByChat = {
				...s.rightPaneLayoutByChat,
				[key]: {
					...(s.rightPaneLayoutByChat[key] ?? closedRightPaneLayout()),
					widthPercent,
				},
			};
			persistRightPaneWidths(rightPaneLayoutByChat);
			return { rightPaneLayoutByChat };
		}),
	setBottomTerminalOpenForChat: (ref, open) =>
		set((s) => {
			const key = rightPaneKey(ref);
			return {
				bottomTerminalLayoutByChat: {
					...s.bottomTerminalLayoutByChat,
					[key]: {
						...(s.bottomTerminalLayoutByChat[key] ??
							closedBottomTerminalLayout()),
						open,
					},
				},
			};
		}),
	setBottomTerminalHeightForChat: (ref, heightPx) =>
		set((s) => {
			if (!Number.isFinite(heightPx) || heightPx <= 0) return s;
			const key = rightPaneKey(ref);
			const bottomTerminalLayoutByChat = {
				...s.bottomTerminalLayoutByChat,
				[key]: {
					...(s.bottomTerminalLayoutByChat[key] ??
						closedBottomTerminalLayout()),
					heightPx,
				},
			};
			persistBottomTerminalHeights(bottomTerminalLayoutByChat);
			return { bottomTerminalLayoutByChat };
		}),
	setActiveBottomTerminalForChat: (ref, terminalId) =>
		set((s) => {
			const key = rightPaneKey(ref);
			return {
				bottomTerminalLayoutByChat: {
					...s.bottomTerminalLayoutByChat,
					[key]: {
						...(s.bottomTerminalLayoutByChat[key] ??
							closedBottomTerminalLayout()),
						activeTerminalId: terminalId,
					},
				},
			};
		}),
	setChatSwitcherOpen: (open) =>
		set(
			open
				? { chatSwitcherOpen: open, fileSearchOpen: false }
				: { chatSwitcherOpen: open },
		),
	toggleChatSwitcher: () =>
		set((s) =>
			s.chatSwitcherOpen
				? { chatSwitcherOpen: false }
				: { chatSwitcherOpen: true, fileSearchOpen: false },
		),
	setFullScreen: (full) => set({ isFullScreen: full }),
	setEnvironmentSummaryOpen: (open) => {
		persistEnvironmentSummaryOpen(open);
		set({ environmentSummaryOpen: open });
	},
	toggleEnvironmentSummary: () =>
		set((s) => {
			const open = !s.environmentSummaryOpen;
			persistEnvironmentSummaryOpen(open);
			return { environmentSummaryOpen: open };
		}),
	setChangesListMode: (mode) => {
		persistChangesListMode(mode);
		set({ changesListMode: mode });
	},
	openDevicePanel: (ref, deviceId, panelId) => {
		get().setRightSidebarOpenForChat(ref, true);
		set((s) => {
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			const existing = panels.find(
				(panel) => panel.kind === "device" && panel.deviceId === deviceId,
			);
			// A picker tab that resolves to an already-open simulator folds into it.
			if (existing)
				return writePanels(
					s,
					key,
					panels.filter(
						(p) =>
							p.id === existing.id ||
							p.id !== panelId ||
							p.kind !== "device" ||
							p.deviceId !== undefined,
					),
					existing.id,
				);
			const panel: PanelInstance = {
				id: panelId ?? newPanelId(),
				kind: "device",
				deviceId,
			};
			return writePanels(
				s,
				key,
				[...panels.filter((p) => p.id !== panelId), panel],
				panel.id,
			);
		});
	},
	showDevicePicker: (ref, panelId) =>
		set((s) => {
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			return writePanels(
				s,
				key,
				panels.map((panel) =>
					panel.id === panelId && panel.kind === "device"
						? { id: panel.id, kind: "device" }
						: panel,
				),
				panelId,
			);
		}),
	addPanel: (ref, kind) =>
		set((s) => {
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			if (SINGLETON_PANEL_KINDS.has(kind)) {
				const existing = panels.find((p) => p.kind === kind);
				if (existing !== undefined) {
					return {
						activeRightPanelByChat: {
							...s.activeRightPanelByChat,
							[key]: existing.id,
						},
					};
				}
				const panel = { id: newPanelId(), kind } as PanelInstance;
				return writePanels(s, key, [...panels, panel], panel.id);
			}
			if (kind === "device") {
				const panel: PanelInstance = { id: newPanelId(), kind: "device" };
				return writePanels(s, key, [...panels, panel], panel.id);
			}
			const slot = panels.filter((p) => p.kind === "terminal").length;
			const panel: PanelInstance = { id: newPanelId(), kind: "terminal", slot };
			return writePanels(s, key, [...panels, panel], panel.id);
		}),
	addTerminalPanelForSlot: (ref, slot) =>
		set((s) => {
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			const panel: PanelInstance = { id: newPanelId(), kind: "terminal", slot };
			return writePanels(s, key, [...panels, panel], panel.id);
		}),
	closePanel: (ref, id) =>
		set((s) => {
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			const idx = panels.findIndex((p) => p.id === id);
			if (idx === -1) return s;
			const next = reindexTerminalSlots(panels.filter((p) => p.id !== id));
			const wasActive = s.activeRightPanelByChat[key] === id;
			const activeId = wasActive
				? (next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null)
				: (s.activeRightPanelByChat[key] ?? null);
			return writePanels(s, key, next, activeId);
		}),
	reconcileTerminalPanelSlots: (ref, removedSlots) =>
		set((s) => {
			if (removedSlots.length === 0) return s;
			const key = rightPaneKey(ref);
			const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
			const removed = new Set(removedSlots);
			const removedPanelIds = new Set(
				panels
					.filter(
						(panel) => panel.kind === "terminal" && removed.has(panel.slot),
					)
					.map((panel) => panel.id),
			);
			const next = panels.flatMap((panel): ReadonlyArray<PanelInstance> => {
				if (panel.kind !== "terminal") return [panel];
				if (removed.has(panel.slot)) return [];
				const shift = removedSlots.filter((slot) => slot < panel.slot).length;
				return shift === 0 ? [panel] : [{ ...panel, slot: panel.slot - shift }];
			});
			const currentActive = s.activeRightPanelByChat[key] ?? null;
			const activeId =
				currentActive !== null && !removedPanelIds.has(currentActive)
					? currentActive
					: (next[0]?.id ?? null);
			return writePanels(s, key, next, activeId);
		}),
	setActiveRightPanel: (ref, id) =>
		set((s) => ({
			activeRightPanelByChat: {
				...s.activeRightPanelByChat,
				[rightPaneKey(ref)]: id,
			},
		})),
	clearChatPanels: (ref) =>
		set((s) => {
			const key = rightPaneKey(ref);
			const { [key]: _droppedPanels, ...rightPanelsByChat } =
				s.rightPanelsByChat;
			const { [key]: _droppedActive, ...activeRightPanelByChat } =
				s.activeRightPanelByChat;
			const { [key]: _droppedSubagent, ...selectedSubagentByChat } =
				s.selectedSubagentByChat;
			const { [key]: _droppedLayout, ...rightPaneLayoutByChat } =
				s.rightPaneLayoutByChat;
			const { [key]: _droppedBottomTerminal, ...bottomTerminalLayoutByChat } =
				s.bottomTerminalLayoutByChat;
			persistRightPaneWidths(rightPaneLayoutByChat);
			persistBottomTerminalHeights(bottomTerminalLayoutByChat);
			return {
				rightPanelsByChat,
				activeRightPanelByChat,
				selectedSubagentByChat,
				rightPaneLayoutByChat,
				bottomTerminalLayoutByChat,
			};
		}),
	revealPanelForChat: (ref, kind) => {
		const key = rightPaneKey(ref);
		get().setRightSidebarOpenForChat(ref, true);
		const s = get();
		const panels = s.rightPanelsByChat[key] ?? EMPTY_PANELS;
		const existing = panels.find((p) => p.kind === kind);
		if (existing !== undefined) {
			set((st) => ({
				activeRightPanelByChat: {
					...st.activeRightPanelByChat,
					[key]: existing.id,
				},
			}));
			return;
		}
		const slot = panels.filter((p) => p.kind === "terminal").length;
		const panel =
			kind === "terminal"
				? ({ id: newPanelId(), kind, slot } satisfies PanelInstance)
				: ({ id: newPanelId(), kind } as PanelInstance);
		set((st) => writePanels(st, key, [...panels, panel], panel.id));
	},
	revealSubagent: (ref, childSessionId) => {
		const key = rightPaneKey(ref);
		set((s) => ({
			rightPaneLayoutByChat: {
				...s.rightPaneLayoutByChat,
				[key]: {
					...(s.rightPaneLayoutByChat[key] ?? closedRightPaneLayout()),
					open: true,
				},
			},
			selectedSubagentByChat: {
				...s.selectedSubagentByChat,
				[key]: childSessionId,
			},
		}));
		get().revealPanelForChat(ref, "subagents");
	},
	selectSubagent: (ref, childSessionId) => {
		const key = rightPaneKey(ref);
		set((s) => ({
			selectedSubagentByChat: {
				...s.selectedSubagentByChat,
				[key]: childSessionId,
			},
		}));
	},
	revealAnnotation: (annotation) =>
		set((s) => ({
			revealedAnnotation: {
				...annotation,
				revealToken: (s.revealedAnnotation?.revealToken ?? 0) + 1,
			},
		})),
	clearRevealedAnnotation: () => set({ revealedAnnotation: null }),
}));
