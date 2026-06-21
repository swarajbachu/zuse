import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Folder01Icon,
  FolderAddIcon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { X } from "lucide-react";
import { useLayoutEffect, useMemo, useState } from "react";

import {
  type ComposerInput,
  defaultModelFor,
  type FolderId,
  type ProviderId,
  type WorktreeId,
} from "@memoize/wire";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { resolveAutoWorktreeId } from "~/lib/auto-worktree";
import { useChatsStore } from "~/store/chats";
import { useMessagesStore } from "~/store/messages";
import { useProvidersStore } from "~/store/providers";
import { DRAFT_SESSION_ID, useSessionsStore } from "~/store/sessions";
import { useSettingsStore } from "~/store/settings";
import { useWorkspaceStore } from "~/store/workspace";
import { EMPTY_WORKTREES, useWorktreesStore } from "~/store/worktrees";
import { ChatComposer } from "./chat-composer.tsx";
import { PROVIDER_LABEL } from "./settings-page";
import { SetupCardView } from "./worktree-setup-card.tsx";

/**
 * Copy the per-session model options (reasoning/effort level + Claude fast
 * mode) that the draft composer wrote under the sentinel draft id over to the
 * real session id, so picks made on the landing carry into the first turn.
 * `ReasoningPicker`/`FastModeToggle` both key sessionStorage by sessionId.
 */
const migrateModelOptions = (fromId: string, toId: string): void => {
  if (typeof window === "undefined") return;
  const prefix = `memoize.modelOptions.${fromId}.`;
  const moves: Array<[string, string]> = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      moves.push([key, `memoize.modelOptions.${toId}.${key.slice(prefix.length)}`]);
    }
  }
  for (const [from, to] of moves) {
    const value = window.sessionStorage.getItem(from);
    if (value !== null) window.sessionStorage.setItem(to, value);
    window.sessionStorage.removeItem(from);
  }
};

/**
 * Landing surface shown in the main pane whenever no chat session is
 * selected — including cold start, after archiving the active session, and
 * for fresh users who haven't typed anything yet.
 *
 * Renders a centered "What should we build in <project>?" headline above a
 * mini composer + project picker + starter-prompt list. On submit we call
 * `useChatsStore.create()` with the typed text as `initialPrompt`; the
 * chat store auto-selects the new session, which causes `MainShell` to
 * swap this surface for `<ChatView />` + `<ChatComposer />` on the next
 * render.
 */
export function ChatLanding() {
  const folders = useWorkspaceStore((s) => s.folders);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.select);
  const addFolder = useWorkspaceStore((s) => s.add);

  const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
  // Goal mode is only offered when the installed Codex CLI is new enough
  // (version-gated capability from the availability probe).
  const codexCapabilities = useProvidersStore((s) =>
    s.capabilitiesFor("codex"),
  );
  const codexGoalSupported =
    defaultProviderId === "codex" && codexCapabilities.includes("goalMode");
  const defaultModelByProvider = useSettingsStore(
    (s) => s.defaultModelByProvider,
  );
  const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
  const defaultAutoCreateWorktree = useSettingsStore(
    (s) => s.defaultAutoCreateWorktree,
  );

  const create = useChatsStore((s) => s.create);
  const send = useMessagesStore((s) => s.send);
  const beginDraft = useSessionsStore((s) => s.beginDraft);
  const clearDraft = useSessionsStore((s) => s.clearDraft);
  // The synthetic draft session that drives the real ChatComposer below. Its
  // model/runtime/permission/provider live here (routed by the sessions-store
  // setters) and are read back at submit so the picks carry into create().
  const draftSession = useSessionsStore((s) => s.draftSession);

  const [submitError, setSubmitError] = useState<string | null>(null);
  // Local "submit in flight" flag. Covers the whole creation window —
  // including the worktree-create step — so the bridge shows the moment the
  // user hits send rather than after the worktree exists.
  const [submitting, setSubmitting] = useState(false);
  // Snapshot of the prompt the user just submitted. Drives the inline
  // setup-card bridge so the form can be hidden during the RPC without the
  // user losing visual continuity with what they sent (shown as queued).
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  // The worktree resolved for this submit (null = main checkout). Lets the
  // bridge card show the real worktree name/branch the instant it exists.
  const [pendingWorktreeId, setPendingWorktreeId] = useState<WorktreeId | null>(
    null,
  );
  // The provider chosen in the composer for this submit (may differ from the
  // default — e.g. the user switched to Grok). Drives the bridge card's
  // "Starting <provider>" label so it matches what's actually booting.
  const [pendingProviderId, setPendingProviderId] = useState<ProviderId | null>(
    null,
  );

  const pendingWorktree = useWorktreesStore((s) => {
    if (selectedFolderId === null || pendingWorktreeId === null) return null;
    const list = s.byProject[selectedFolderId] ?? EMPTY_WORKTREES;
    return list.find((w) => w.id === pendingWorktreeId) ?? null;
  });

  const selectedFolder = useMemo(
    () =>
      selectedFolderId === null
        ? null
        : (folders.find((f) => f.id === selectedFolderId) ?? null),
    [folders, selectedFolderId],
  );

  // Spin up (or re-spin, on project switch) the draft session that backs the
  // composer. Re-runs only when the project changes — model/provider/runtime
  // edits the user makes inside the composer mutate the draft in place, so we
  // must not clobber them on unrelated default-settings changes.
  useLayoutEffect(() => {
    if (selectedFolderId === null) {
      clearDraft();
      return;
    }
    beginDraft({
      projectId: selectedFolderId,
      providerId: defaultProviderId,
      model:
        defaultModelByProvider[defaultProviderId] ??
        defaultModelFor(defaultProviderId),
      runtimeMode: defaultRuntimeMode,
    });
    return () => clearDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderId]);

  const headline = selectedFolder
    ? `What should we build in ${selectedFolder.name}?`
    : "What should we build today?";

  const onPick = (folderId: FolderId) => {
    void selectFolder(folderId);
  };
  const onAdd = () => {
    void addFolder();
  };

  // Driven by the real ChatComposer (draft mode): it hands back the parsed
  // input (file refs / attachments / skills / annotations intact) and whether
  // goal mode was on. We create the worktree + chat with the draft's chosen
  // provider/model/runtime/permission, carry the model options over, then
  // queue the message (held until setup completes, or flushed immediately when
  // there's no worktree). Identical sequencing to the old textarea submit.
  const handleDraftSubmit = async (
    input: ComposerInput,
    opts: { asGoal: boolean },
  ): Promise<void> => {
    if (selectedFolderId === null || submitting) return;
    const draft = useSessionsStore.getState().draftSession;
    if (draft === null) return;
    setSubmitError(null);
    setSubmitting(true);
    setPendingProviderId(draft.providerId);
    setPendingPrompt(input.text.trim().length > 0 ? input.text.trim() : "New chat");
    const worktreeId = await resolveAutoWorktreeId(selectedFolderId);
    setPendingWorktreeId(worktreeId);
    const result = await create(selectedFolderId, draft.providerId, draft.model, {
      runtimeMode: draft.runtimeMode,
      permissionMode: draft.permissionMode,
      worktreeId,
    });
    if (result === null) {
      const reason =
        useChatsStore.getState().error ??
        `Couldn't start ${draft.providerId}. Check that its CLI is installed and signed in.`;
      setSubmitError(reason);
      setPendingPrompt(null);
      setPendingWorktreeId(null);
      setPendingProviderId(null);
      setSubmitting(false);
      return;
    }
    const sessionId = result.initialSessionId;
    migrateModelOptions(DRAFT_SESSION_ID, sessionId);
    if (opts.asGoal && codexGoalSupported) {
      void send(sessionId, input, { asGoal: true });
    } else {
      useMessagesStore.getState().queue(sessionId, input);
      // When a worktree was created, hold this first turn until setup
      // finishes — the worktrees setup stream flushes the queue on the
      // terminal status. With no worktree there's nothing to wait for.
      if (worktreeId === null) {
        useMessagesStore.getState().flushQueue(sessionId);
      }
    }
    useSessionsStore.getState().clearDraft();
  };

  // Bridge: covers the brief create() RPC window (worktree → chat) before the
  // session exists and MainShell swaps us for the real ChatView + composer.
  // Mirrors that layout — the unified setup card on top, the queued message
  // pinned at the bottom — so the handoff to the live card is seamless.
  if (submitting && pendingPrompt !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SetupCardView
            data={{
              repoName: selectedFolder?.name ?? "this repo",
              hasWorktree: defaultAutoCreateWorktree,
              worktreePending: pendingWorktree === null,
              worktreeName: pendingWorktree?.name ?? null,
              branch: pendingWorktree?.branch ?? null,
              baseBranch: pendingWorktree?.baseBranch ?? null,
              setupStatus: pendingWorktree?.setupStatus ?? null,
              setupOutput: pendingWorktree?.setupOutput ?? "",
              providerLabel: (() => {
                const pid = pendingProviderId ?? defaultProviderId;
                return PROVIDER_LABEL[pid] ?? pid;
              })(),
              providerState: "active",
              onRerun: null,
            }}
          />
        </div>
        <div className="px-4 pb-4">
          <QueuedComposerPill prompt={pendingPrompt} count={1} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-center text-xl font-medium text-foreground/90">
          {headline}
        </h1>

        {submitError !== null && (
          <div className="mx-auto flex w-full max-w-2xl items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-rose-200">
            <span className="mt-px shrink-0">⚠</span>
            <span className="flex-1 leading-snug">{submitError}</span>
            <button
              type="button"
              onClick={() => setSubmitError(null)}
              aria-label="Dismiss error"
              className="-mr-1 shrink-0 rounded p-0.5 text-rose-200/80 hover:bg-rose-500/[0.12] hover:text-rose-100"
            >
              <X className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
        )}

        {/* The REAL ChatComposer in draft mode — one source of truth for file
            tagging, model/thinking, fast mode, plan mode, runtime, etc. On
            send it hands the parsed input back to `handleDraftSubmit`. */}
        {draftSession !== null ? (
          <ChatComposer
            key={selectedFolderId ?? "none"}
            session={draftSession}
            onDraftSubmit={(input, opts) => void handleDraftSubmit(input, opts)}
          />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            Pick a project below to start a new chat.
          </p>
        )}

        <div className="flex justify-center">
          <ProjectPicker
            folders={folders}
            selectedFolderId={selectedFolderId}
            selectedName={selectedFolder?.name ?? null}
            onPick={onPick}
            onAdd={onAdd}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact "queued first message" indicator shown in the landing bridge while
 * the worktree/chat is being created. Mirrors the queue chips the real
 * composer's `QueueTray` shows once the session exists, so the message reads
 * as held-not-sent throughout.
 */
function QueuedComposerPill({
  prompt,
  count,
}: {
  prompt: string;
  count: number;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-2.5 text-[13px]">
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-foreground/80">{prompt}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} queued
        </span>
      </div>
    </div>
  );
}

function ProjectPicker({
  folders,
  selectedFolderId,
  selectedName,
  onPick,
  onAdd,
}: {
  folders: ReturnType<typeof useWorkspaceStore.getState>["folders"];
  selectedFolderId: FolderId | null;
  selectedName: string | null;
  onPick: (folderId: FolderId) => void;
  onAdd: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground hover:bg-muted/60 data-[popup-open]:bg-muted/60"
        aria-label="Pick a project"
      >
        <HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
        <span>{selectedName ?? "Pick a project"}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="w-64 p-1">
        {folders.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No projects yet.
          </div>
        ) : (
          folders.map((folder) => {
            const active = folder.id === selectedFolderId;
            return (
              <MenuItem
                key={folder.id}
                onClick={() => onPick(folder.id)}
                className={cn(
                  "grid grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm",
                  active
                    ? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
                    : undefined,
                )}
              >
                <span className="col-start-1 row-start-1 flex items-center justify-center">
                  {active && (
                    <HugeiconsIcon
                      icon={Tick01Icon}
                      className="size-3.5 opacity-90"
                    />
                  )}
                </span>
                <HugeiconsIcon
                  icon={Folder01Icon}
                  className="col-start-2 row-start-1 size-3.5 opacity-80"
                />
                <span className="col-start-3 row-start-1 truncate">
                  {folder.name}
                </span>
              </MenuItem>
            );
          })
        )}
        <MenuSeparator />
        <MenuItem
          onClick={onAdd}
          className="grid grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm"
        >
          <span className="col-start-1 row-start-1" />
          <HugeiconsIcon
            icon={FolderAddIcon}
            className="col-start-2 row-start-1 size-3.5 opacity-80"
          />
          <span className="col-start-3 row-start-1">Add new project</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
