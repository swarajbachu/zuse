import {
	EnvironmentId,
	CommandId,
	type FolderId,
	Worktree,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import { toastManager } from "../components/ui/toast.tsx";
import { activeChatsByProject } from "../lib/environment-entities.ts";
import { formatError } from "../lib/format-error.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { openTerminalCommand } from "../lib/run-terminal.ts";
import {
	followWorktreeSetup,
	dispatchWorktreeCommand,
	stopFollowingWorktreeSetup,
} from "../lib/worktree-setup-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "./repository-settings.ts";

/** Rarities worth interrupting the user with a one-off unlock toast. */
const NOTABLE_RARITIES: ReadonlySet<string> = new Set([
	"rare",
	"epic",
	"legendary",
]);

type WorktreesByProject = Readonly<Record<string, ReadonlyArray<Worktree>>>;

/**
 * Stable reference for "no worktrees yet" so selectors written as
 * `s.byProject[projectId] ?? EMPTY` don't return a new array each render
 * — that would invalidate the external-store `Object.is` snapshot and trigger a
 * `getSnapshot` infinite loop in React 19.
 */
export const EMPTY_WORKTREES: ReadonlyArray<Worktree> = Object.freeze([]);

type WorktreesState = {
	readonly byProject: WorktreesByProject;
	readonly loading: ReadonlySet<FolderId>;
	readonly creatingSetupByProject: ReadonlySet<FolderId>;
	readonly setupPending: ReadonlySet<WorktreeId>;
	readonly error: string | null;
	readonly refresh: (projectId: FolderId) => Promise<void>;
	readonly create: (
		projectId: FolderId,
		source?: WorktreeCreateSource,
	) => Promise<Worktree | null>;
	readonly rerunSetup: (
		projectId: FolderId,
		worktreeId: WorktreeId,
	) => Promise<Worktree | null>;
	/**
	 * Drain a worktree's live `setupStream`, patching `setupStatus`/`setupOutput`
	 * as events arrive. Idempotent; auto-stops when setup completes. On a
	 * terminal status it kicks `maybeAutoRun`.
	 */
	readonly subscribeSetup: (
		projectId: FolderId,
		worktreeId: WorktreeId,
	) => void;
	readonly unsubscribeSetup: (
		projectId: FolderId,
		worktreeId: WorktreeId,
	) => void;
	readonly startRun: (worktreeId: WorktreeId) => Promise<{
		readonly cwd: string;
		readonly script: string;
		readonly env: Record<string, string>;
	} | null>;
	readonly remove: (
		projectId: FolderId,
		worktreeId: WorktreeId,
	) => Promise<
		{ readonly ok: true } | { readonly ok: false; readonly reason: string }
	>;
};

const activeEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(useEnvironmentCatalogStore.getState().activeEnvironmentId);

type WorktreeCommand = <Result>(input: {
	readonly environmentId: EnvironmentId;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId;
	readonly kind:
		| "worktree.rerunSetup"
		| "worktree.startRun"
		| "worktree.remove";
	readonly payload: Readonly<Record<string, unknown>>;
}) => Promise<Result>;

let runWorktreeCommand: WorktreeCommand = async <Result>(
	input: Parameters<WorktreeCommand>[0],
) =>
	(
		await dispatchWorktreeCommand<Readonly<Record<string, unknown>>, Result>({
			...input,
			commandId: CommandId.make(`worktree:${crypto.randomUUID()}`),
		})
	).result;

export const setWorktreeCommandForTest = (command: WorktreeCommand): void => {
	runWorktreeCommand = command;
};

const maybeAutoRun = async (projectId: FolderId, wt: Worktree) => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const settings =
		useRepositorySettingsStore.getState().byProject[
			repositorySettingsKey(environmentId, projectId)
		] ??
		(await useRepositorySettingsStore
			.getState()
			.refresh(environmentId, projectId));
	if (settings?.autoRunAfterSetup !== true) return;
	if (wt.setupStatus !== "succeeded" && wt.setupStatus !== "skipped") return;
	// Terminals are per chat — surface the auto-run in the chat that owns this
	// worktree. Without one (none bound it), there's no dock to land it in.
	const chat = (activeChatsByProject()[projectId] ?? []).find(
		(c) => c.worktreeId === wt.id,
	);
	if (chat === undefined) return;
	const run = await useWorktreesStore.getState().startRun(wt.id);
	if (run === null) return;
	openTerminalCommand({
		chatRef: {
			environmentId,
			chatId: chat.id,
		},
		cwd: run.cwd,
		title: "Run",
		command: { cmd: "/bin/zsh", args: ["-lc", run.script], env: run.env },
	});
};

const TERMINAL_SETUP = new Set(["succeeded", "failed", "skipped"]);

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
	byProject: {},
	loading: new Set(),
	creatingSetupByProject: new Set(),
	setupPending: new Set(),
	error: null,
	refresh: async (projectId) => {
		set((s) => {
			const next = new Set(s.loading);
			next.add(projectId);
			return { loading: next };
		});
		try {
			const environmentId = activeEnvironmentId();
			const { result: list } = await dispatchEnvironmentShellCommand<
				{ readonly projectId: FolderId },
				ReadonlyArray<Worktree>
			>({
				environmentId,
				kind: "worktree.list",
				commandId: CommandId.make(`worktree-list:${crypto.randomUUID()}`),
				payload: { projectId },
			});
			if (environmentId !== activeEnvironmentId()) return;
			set((s) => ({
				byProject: { ...s.byProject, [projectId]: list },
				loading: (() => {
					const n = new Set(s.loading);
					n.delete(projectId);
					return n;
				})(),
				error: null,
			}));
		} catch (err) {
			set((s) => ({
				loading: (() => {
					const n = new Set(s.loading);
					n.delete(projectId);
					return n;
				})(),
				error: formatError(err),
			}));
		}
	},
	create: async (projectId, source) => {
		set((s) => {
			const next = new Set(s.creatingSetupByProject);
			next.add(projectId);
			return { creatingSetupByProject: next };
		});
		try {
			const environmentId = activeEnvironmentId();
			const { result: wt } = await dispatchEnvironmentShellCommand<
				{
					readonly projectId: FolderId;
					readonly source?: WorktreeCreateSource;
				},
				Worktree
			>({
				environmentId,
				kind: "worktree.create",
				commandId: CommandId.make(`worktree-create:${crypto.randomUUID()}`),
				payload: source === undefined ? { projectId } : { projectId, source },
			});
			if (environmentId !== activeEnvironmentId()) return null;
			set((s) => {
				const existing = s.byProject[projectId] ?? [];
				return {
					byProject: { ...s.byProject, [projectId]: [wt, ...existing] },
					creatingSetupByProject: (() => {
						const next = new Set(s.creatingSetupByProject);
						next.delete(projectId);
						return next;
					})(),
					error: null,
				};
			});
			if (wt.pokemon !== null && NOTABLE_RARITIES.has(wt.pokemon.rarity)) {
				const rarity =
					wt.pokemon.rarity.charAt(0).toUpperCase() +
					wt.pokemon.rarity.slice(1);
				toastManager.add({
					title: `${rarity} unlock!`,
					description: `${wt.pokemon.name} joined your Pokédex`,
					type: "success",
				});
			}
			// Setup now runs detached on the server; follow it live and let the
			// stream's terminal-status handler fire maybeAutoRun.
			get().subscribeSetup(projectId, wt.id);
			return wt;
		} catch (err) {
			set((s) => {
				const next = new Set(s.creatingSetupByProject);
				next.delete(projectId);
				return { creatingSetupByProject: next, error: formatError(err) };
			});
			return null;
		}
	},
	rerunSetup: async (projectId, worktreeId) => {
		set((s) => {
			const next = new Set(s.setupPending);
			next.add(worktreeId);
			return { setupPending: next };
		});
		try {
			const wt = await runWorktreeCommand<Worktree>({
				environmentId: activeEnvironmentId(),
				projectId,
				worktreeId,
				kind: "worktree.rerunSetup",
				payload: { worktreeId },
			});
			set((s) => {
				const list = s.byProject[projectId] ?? [];
				return {
					byProject: {
						...s.byProject,
						[projectId]: list.map((existing) =>
							existing.id === wt.id ? wt : existing,
						),
					},
					setupPending: (() => {
						const next = new Set(s.setupPending);
						next.delete(worktreeId);
						return next;
					})(),
					error: null,
				};
			});
			// Rerun is non-blocking server-side now; follow the fresh run live.
			get().subscribeSetup(projectId, worktreeId);
			return wt;
		} catch (err) {
			set((s) => {
				const next = new Set(s.setupPending);
				next.delete(worktreeId);
				return { setupPending: next, error: formatError(err) };
			});
			return null;
		}
	},
	startRun: async (worktreeId) => {
		try {
			const projectId = Object.entries(get().byProject).find(([, worktrees]) =>
				worktrees.some((worktree) => worktree.id === worktreeId),
			)?.[0] as FolderId | undefined;
			if (projectId === undefined) return null;
			return await runWorktreeCommand({
				environmentId: activeEnvironmentId(),
				projectId,
				worktreeId,
				kind: "worktree.startRun",
				payload: { worktreeId },
			});
		} catch (err) {
			set({ error: formatError(err) });
			return null;
		}
	},
	subscribeSetup: (projectId, worktreeId) => {
		followWorktreeSetup(projectId, worktreeId, (event) => {
			set((state) => {
				const list = state.byProject[projectId];
				if (list === undefined) return state;
				return {
					byProject: {
						...state.byProject,
						[projectId]: list.map((worktree) =>
							worktree.id !== worktreeId
								? worktree
								: event._tag === "chunk"
									? Worktree.make({ ...worktree, setupOutput: event.output })
									: Worktree.make({
											...worktree,
											setupStatus: event.status,
											setupStartedAt: event.setupStartedAt,
											setupFinishedAt: event.setupFinishedAt,
										}),
						),
					},
				};
			});
			if (event._tag === "status" && TERMINAL_SETUP.has(event.status)) {
				const worktree = (get().byProject[projectId] ?? []).find(
					(candidate) => candidate.id === worktreeId,
				);
				if (worktree !== undefined) void maybeAutoRun(projectId, worktree);
			}
		});
	},
	unsubscribeSetup: stopFollowingWorktreeSetup,
	remove: async (projectId, worktreeId) => {
		try {
			await runWorktreeCommand({
				environmentId: activeEnvironmentId(),
				projectId,
				worktreeId,
				kind: "worktree.remove",
				payload: { worktreeId },
			});
			get().unsubscribeSetup(projectId, worktreeId);
			set((s) => {
				const list = s.byProject[projectId] ?? [];
				return {
					byProject: {
						...s.byProject,
						[projectId]: list.filter((w) => w.id !== worktreeId),
					},
					error: null,
				};
			});
			return { ok: true } as const;
		} catch (err) {
			const reason = formatError(err);
			set({ error: reason });
			return { ok: false, reason } as const;
		}
	},
}));

export const selectWorktreesFor = (
	projectId: FolderId,
): ReadonlyArray<Worktree> =>
	useWorktreesStore.getState().byProject[projectId] ?? [];
