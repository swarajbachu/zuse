import type {
  Chat,
  Folder,
  GitBranchInfo,
  GitPrSummary,
  PermissionMode,
  ProviderId,
  RuntimeMode,
  Worktree,
  WorktreeCreateSource,
  WorktreeId,
} from "@zuse/wire";

export type NewChatSource =
  | { kind: "main"; label: string; worktreeId: null; createSource?: undefined }
  | {
      kind: "worktree";
      label: string;
      worktreeId: WorktreeId;
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
 * work-mode, derived from the already-fetched worktree/branch/PR lists. Pure so
 * the row content is testable. Builds the same {@link NewChatSource} objects
 * the screen used before the layout change.
 */
export const sourceOptionsForKind = (
  kind: NewChatSourceKind,
  worktrees: readonly Worktree[],
  branches: readonly GitBranchInfo[],
  prs: readonly GitPrSummary[],
): NewChatSourceOption[] => {
  switch (kind) {
    case "main":
      return [{ key: "main", label: MAIN_SOURCE.label, source: MAIN_SOURCE }];
    case "worktree":
      return worktrees.map((worktree) => ({
        key: worktree.id,
        label: worktree.branch,
        source: {
          kind: "worktree",
          label: worktree.branch,
          worktreeId: worktree.id,
        },
      }));
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
