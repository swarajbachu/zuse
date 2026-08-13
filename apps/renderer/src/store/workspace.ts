import type { Folder, FolderId } from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { activeEnvironmentShellData } from "../lib/environment-entities.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { getActiveEnvironment } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

type WorkspaceState = {
	folders: ReadonlyArray<Folder>;
	selectedFolderId: FolderId | null;
	loading: boolean;
	error: string | null;
	load: () => Promise<void>;
	add: () => Promise<void>;
	remove: (folderId: FolderId) => Promise<void>;
	select: (folderId: FolderId) => Promise<void>;
};

export const registerFolder = (
	state: Pick<WorkspaceState, "folders" | "selectedFolderId">,
	folder: Folder,
): Pick<WorkspaceState, "folders" | "selectedFolderId"> => {
	const existing = state.folders.find(
		(existing) => existing.id === folder.id || existing.path === folder.path,
	);
	return {
		folders:
			existing === undefined ? [...state.folders, folder] : state.folders,
		selectedFolderId: existing?.id ?? folder.id,
	};
};

const persistSelection = async (folderId: FolderId | null): Promise<void> => {
	try {
		await dispatchWorkspaceCommand<void>("workspace.setSelected", { folderId });
	} catch {
		// best-effort persistence; the in-memory store already updated
	}
};

let workspaceCommandCounter = 0;
const dispatchWorkspaceCommand = <Result>(kind: string, payload: unknown) =>
	dispatchEnvironmentShellCommand<unknown, Result>({
		environmentId: EnvironmentId.make(getActiveEnvironment()),
		kind,
		commandId: CommandId.make(
			`${kind}:${Date.now().toString(36)}:${(workspaceCommandCounter++).toString(36)}`,
		),
		payload,
	});

const formatError = (err: unknown): string => {
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null) {
		// TaggedErrors travel over RPC carrying `_tag` plus their schema
		// fields. Prefer the human-readable ones over the bare tag — the
		// dialog inline-renders this string verbatim.
		const obj = err as Record<string, unknown>;
		if (typeof obj.reason === "string" && obj.reason.length > 0) {
			return obj.reason;
		}
		if (typeof obj._tag === "string") return obj._tag;
	}
	return String(err);
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	folders: [],
	selectedFolderId: null,
	loading: false,
	error: null,
	load: async () => {
		set({ loading: true, error: null });
		try {
			const folders = activeEnvironmentShellData()?.folders ?? get().folders;
			const persisted = (
				await dispatchWorkspaceCommand<FolderId | null>(
					"workspace.getSelected",
					{},
				)
			).result;
			const selected =
				persisted !== null && folders.some((folder) => folder.id === persisted)
					? persisted
					: get().selectedFolderId !== null &&
							folders.some((folder) => folder.id === get().selectedFolderId)
						? get().selectedFolderId
						: (folders[0]?.id ?? null);
			set({ folders, selectedFolderId: selected, loading: false });
			if (selected !== persisted) await persistSelection(selected);
		} catch (cause) {
			set({ error: formatError(cause), loading: false });
		}
	},
	add: async () => {
		set({ error: null });
		try {
			const path = (
				await dispatchWorkspaceCommand<string | null>(
					"workspace.pickFolder",
					{},
				)
			).result;
			if (path === null) return;
			const folder = (
				await dispatchWorkspaceCommand<Folder>("workspace.add", {
					path,
				})
			).result;
			set((s) => registerFolder(s, folder));
			await persistSelection(folder.id);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	remove: async (folderId) => {
		set({ error: null });
		try {
			await dispatchWorkspaceCommand<void>("workspace.remove", { folderId });
			const nextSelected = (() => {
				const s = get();
				const folders = s.folders.filter((f) => f.id !== folderId);
				const selectedFolderId =
					s.selectedFolderId === folderId
						? (folders[0]?.id ?? null)
						: s.selectedFolderId;
				set({ folders, selectedFolderId });
				return { selectedFolderId, changed: s.selectedFolderId === folderId };
			})();
			if (nextSelected.changed)
				await persistSelection(nextSelected.selectedFolderId);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	select: async (folderId) => {
		if (get().selectedFolderId === folderId) return;
		set({ selectedFolderId: folderId });
		await persistSelection(folderId);
	},
}));
