import type {
  Chat,
  Folder,
  PermissionMode,
  ProviderId,
  RuntimeMode,
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
