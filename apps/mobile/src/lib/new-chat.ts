import type {
	Chat,
	Folder,
	GitBranchInfo,
	GitPrSummary,
	PermissionMode,
	ProviderId,
	RuntimeMode,
	WorktreeCreateSource,
	WorktreeId,
} from "@zuse/contracts";

export type NewChatSource =
	| { kind: "main"; label: string; worktreeId: null; createSource?: undefined }
	| {
			kind: "worktree";
			label: string;
			worktreeId: null;
			createSource?: undefined;
	  }
	| {
			kind: "branch";
			label: string;
			worktreeId: null;
			createSource: WorktreeCreateSource;
	  }
	| {
			kind: "pr";
			label: string;
			worktreeId: null;
			createSource: WorktreeCreateSource;
	  };

export type NewChatDraft = {
	connectionKey: string | null;
	projectId: Folder["id"] | null;
	providerId: ProviderId;
	model: string;
	runtimeMode: RuntimeMode;
	permissionMode: PermissionMode;
	modelOptions?: Record<string, string>;
	source: NewChatSource;
	text: string;
};

export type NewChatCreatePayload = {
	projectId: Folder["id"];
	providerId: ProviderId;
	model: string;
	runtimeMode: RuntimeMode;
	permissionMode: PermissionMode;
	modelOptions?: Record<string, string>;
	initialPrompt: string;
	worktreeId: WorktreeId | null;
	createWorktree: boolean;
	createSource: WorktreeCreateSource | null;
};

export const MAIN_SOURCE: NewChatSource = {
	kind: "main",
	label: "Main checkout",
	worktreeId: null,
};

export type NewChatSourceKind = NewChatSource["kind"];

/** A pickable source in the branch selector for a given work-mode. */
export type NewChatSourceOption = {
	key: string;
	label: string;
	source: NewChatSource;
};

/** Work-mode categories shown in the new-chat work-mode selector. */
export const WORK_MODE_OPTIONS: readonly {
	kind: NewChatSourceKind;
	label: string;
}[] = [
	{ kind: "main", label: "Work locally" },
	{ kind: "worktree", label: "New worktree" },
	{ kind: "branch", label: "Existing branch" },
	{ kind: "pr", label: "Pull request" },
];

export const workModeLabel = (kind: NewChatSourceKind): string =>
	WORK_MODE_OPTIONS.find((option) => option.kind === kind)?.label ??
	"Work locally";

/**
 * The concrete source options for the branch selector given the chosen
 * work-mode, derived from the already-fetched branch/PR lists. Pure so the row
 * content and create semantics remain testable outside the screen.
 */
export const sourceOptionsForKind = (
	kind: NewChatSourceKind,
	branches: readonly GitBranchInfo[],
	prs: readonly GitPrSummary[],
): NewChatSourceOption[] => {
	switch (kind) {
		case "main":
			return [{ key: "main", label: MAIN_SOURCE.label, source: MAIN_SOURCE }];
		case "worktree": {
			// A source-less worktree.create is the server's real "new worktree"
			// path: it creates a fresh generated branch from origin's default branch.
			// Prefer the conventional default branch names for the pre-create label;
			// the server remains authoritative when it resolves origin/HEAD.
			const baseBranch =
				branches.find((branch) => branch.name === "main") ??
				branches.find((branch) => branch.name === "master") ??
				branches.find((branch) => branch.current);
			const label = baseBranch?.name ?? "Default branch";
			return [
				{
					key: `new-worktree:${label}`,
					label,
					source: {
						kind: "worktree",
						label,
						worktreeId: null,
					},
				},
			];
		}
		case "branch":
			return branches
				.filter((branch) => !branch.current)
				.map((branch) => ({
					key: `${branch.kind}:${branch.name}`,
					label: branch.name,
					source: {
						kind: "branch",
						label: branch.name,
						worktreeId: null,
						createSource: {
							_tag: "branch",
							branch: branch.name,
							remote: branch.remote,
						},
					},
				}));
		case "pr":
			return prs.map((pr) => ({
				key: `pr:${pr.number}`,
				label: `#${pr.number} ${pr.title}`,
				source: {
					kind: "pr",
					label: `#${pr.number}`,
					worktreeId: null,
					createSource: {
						_tag: "pr",
						number: pr.number,
						headRefName: pr.headRefName,
					},
				},
			}));
	}
};

export const buildNewChatCreatePayload = (
	draft: NewChatDraft,
): NewChatCreatePayload | null => {
	const text = draft.text.trim();
	if (draft.projectId === null || text.length === 0) return null;
	return {
		projectId: draft.projectId,
		providerId: draft.providerId,
		model: draft.model,
		runtimeMode: draft.runtimeMode,
		permissionMode: draft.permissionMode,
		...(draft.modelOptions !== undefined
			? { modelOptions: draft.modelOptions }
			: {}),
		initialPrompt: text,
		worktreeId: draft.source.worktreeId,
		createWorktree: draft.source.kind !== "main",
		createSource: draft.source.createSource ?? null,
	};
};

export const patchBundlesWithCreatedChat = (
	bundles: readonly {
		project: Folder;
		chats: readonly Chat[];
		sessions: readonly ChatSessionLike[];
	}[],
	projectId: Folder["id"],
	chat: Chat,
	initialSession: ChatSessionLike,
) =>
	bundles.map((bundle) =>
		bundle.project.id !== projectId
			? bundle
			: {
					...bundle,
					chats: [chat, ...bundle.chats.filter((item) => item.id !== chat.id)],
					sessions: [
						initialSession,
						...bundle.sessions.filter((item) => item.id !== initialSession.id),
					],
				},
	);

type ChatSessionLike = {
	id: string;
	chatId: string;
};
