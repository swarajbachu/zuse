import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Folder01Icon,
  FolderAddIcon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { Effect } from "effect";

import {
  type ComposerInput,
  defaultModelFor,
  type FolderId,
  type ProviderId,
  type WorktreeCreateSource,
  type WorktreeId,
} from "@zuse/wire";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "~/components/ui/frame";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { resolveAutoWorktreeId } from "~/lib/auto-worktree";
import { useChatsStore } from "~/store/chats";
import { useMessagesStore } from "~/store/messages";
import { useProvidersStore } from "~/store/providers";
import { useExternalThreadsStore } from "~/store/external-threads";
import { DRAFT_SESSION_ID, useSessionsStore } from "~/store/sessions";
import { useSettingsStore } from "~/store/settings";
import { useWorkspaceStore } from "~/store/workspace";
import { EMPTY_WORKTREES, useWorktreesStore } from "~/store/worktrees";
import { composerDraftKeyForLanding } from "~/store/composer-drafts";
import { useComposerBridge } from "~/store/composer-bridge";
import { saveContextFile } from "~/lib/context-handoff";
import { getRpcClient } from "~/lib/rpc-client";
import {
  CreateFromMenu,
  type CreateFromSelection,
} from "./composer/create-from-menu.tsx";
import { ChatComposer } from "./chat-composer.tsx";
import { PROVIDER_LABEL } from "./settings-page";
import { ProviderIcon } from "./provider-icons";
import { SetupCardView } from "./worktree-setup-card.tsx";

/**
 * Copy the per-session model options (reasoning/effort level + Claude fast
 * mode) that the draft composer wrote under the sentinel draft id over to the
 * real session id, so picks made on the landing carry into the first turn.
 * `ReasoningPicker`/`FastModeToggle` both key sessionStorage by sessionId.
 */
const migrateModelOptions = (fromId: string, toId: string): void => {
  if (typeof window === "undefined") return;
  const prefix = `zuse.modelOptions.${fromId}.`;
  const legacyPrefix = `memoize.modelOptions.${fromId}.`;
  const moves: Array<[string, string]> = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      moves.push([
        key,
        `zuse.modelOptions.${toId}.${key.slice(prefix.length)}`,
      ]);
    } else if (key !== null && key.startsWith(legacyPrefix)) {
      moves.push([
        key,
        `zuse.modelOptions.${toId}.${key.slice(legacyPrefix.length)}`,
      ]);
    }
  }
  for (const [from, to] of moves) {
    const value = window.sessionStorage.getItem(from);
    if (value !== null) window.sessionStorage.setItem(to, value);
    window.sessionStorage.removeItem(from);
  }
};

const formatThreadRelative = (date: Date): string => {
  const ms = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
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
  const externalThreads = useExternalThreadsStore((s) => s.threads);
  const externalThreadsLoading = useExternalThreadsStore((s) => s.loading);
  const continuingExternalThreadId = useExternalThreadsStore(
    (s) => s.continuingId,
  );
  const hydrateExternalThreads = useExternalThreadsStore((s) => s.hydrate);
  const continueExternalThread = useExternalThreadsStore(
    (s) => s.continueThread,
  );

  const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
  // Goal mode is offered for Codex (version-gated `goalMode` capability) and
  // Grok (native `/goal`, advertised unconditionally) — both surface the
  // capability via the availability probe.
  const defaultProviderCapabilities = useProvidersStore((s) =>
    s.capabilitiesFor(defaultProviderId),
  );
  const goalSupported =
    defaultProviderId === "grok" ||
    (defaultProviderId === "codex" &&
      defaultProviderCapabilities.includes("goalMode"));
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

  // The PR / branch / issue the user chose via "Create from…", if any. For a
  // PR/branch we eagerly check out a worktree (or reuse an "In use" one) and
  // pin `worktreeId`; the first send binds the chat to it. For an issue we
  // stash its Markdown + prefill the composer with the title — no worktree.
  const [createSource, setCreateSource] = useState<{
    readonly kind: CreateFromSelection["kind"];
    readonly worktreeId: WorktreeId | null;
    readonly label: string;
    readonly issue: {
      readonly markdown: string;
      readonly title: string;
    } | null;
  } | null>(null);
  const [creatingSource, setCreatingSource] = useState(false);

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
    // A create-from source is scoped to the project it was picked in.
    setCreateSource(null);
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

  useEffect(() => {
    void hydrateExternalThreads();
  }, [hydrateExternalThreads]);

  const headline = selectedFolder
    ? `What should we build in ${selectedFolder.name}?`
    : "What should we build today?";

  const onPick = (folderId: FolderId) => {
    void selectFolder(folderId);
  };
  const onAdd = () => {
    void addFolder();
  };

  // "Create from…" pick. PR/branch → check out a worktree now (or reuse the
  // "In use" one) and remember its id; the first send binds the chat to it.
  // Issue → fetch its Markdown, prefill the composer with the title, and hold
  // the body to attach into the chat's `.context/files/` at submit.
  const handleCreateFromSelect = async (
    sel: CreateFromSelection,
  ): Promise<void> => {
    if (selectedFolderId === null || creatingSource) return;
    setSubmitError(null);
    if (sel.kind === "issue") {
      try {
        const client = await getRpcClient();
        const res = await Effect.runPromise(
          client.git.issueMarkdown({
            folderId: selectedFolderId,
            number: sel.number,
          }),
        );
        setCreateSource({
          kind: "issue",
          worktreeId: null,
          label: `#${sel.number}`,
          issue: { markdown: res.markdown, title: res.title || sel.title },
        });
        // Prefill the composer with an editable default the user can rewrite.
        const insert = useComposerBridge.getState().insertText;
        if (insert !== null) insert(res.title || sel.title);
      } catch {
        setSubmitError(
          "Couldn't load that issue. Is the GitHub CLI (gh) signed in?",
        );
      }
      return;
    }
    // PR / branch: reuse an existing worktree when the row was "In use",
    // otherwise check one out now against that ref.
    const label =
      sel.kind === "pr" ? `PR #${sel.number} · ${sel.headRefName}` : sel.branch;
    if (sel.existingWorktreeId !== null) {
      setCreateSource({
        kind: sel.kind,
        worktreeId: sel.existingWorktreeId,
        label,
        issue: null,
      });
      return;
    }
    const source: WorktreeCreateSource =
      sel.kind === "pr"
        ? { _tag: "pr", number: sel.number, headRefName: sel.headRefName }
        : { _tag: "branch", branch: sel.branch, remote: sel.remote };
    setCreatingSource(true);
    const wt = await useWorktreesStore
      .getState()
      .create(selectedFolderId, source);
    setCreatingSource(false);
    if (wt === null) {
      setSubmitError(
        useWorktreesStore.getState().error ?? `Couldn't check out ${label}.`,
      );
      return;
    }
    setCreateSource({ kind: sel.kind, worktreeId: wt.id, label, issue: null });
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
    setPendingPrompt(
      input.text.trim().length > 0 ? input.text.trim() : "New chat",
    );
    // A "Create from…" PR/branch already checked out (or reused) a worktree —
    // pin the chat to it. Otherwise fall back to the normal auto-worktree.
    const worktreeId =
      createSource !== null && createSource.worktreeId !== null
        ? createSource.worktreeId
        : await resolveAutoWorktreeId(selectedFolderId);
    setPendingWorktreeId(worktreeId);
    const result = await create(
      selectedFolderId,
      draft.providerId,
      draft.model,
      {
        runtimeMode: draft.runtimeMode,
        permissionMode: draft.permissionMode,
        worktreeId,
      },
    );
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
    // Issue source: write its Markdown into the chat's real worktree cwd and
    // attach it as an `@`-file so the agent reads it from its own cwd (works
    // for both the Claude `@relPath` and Codex `absPath` mention paths).
    let finalInput = input;
    if (createSource?.issue != null) {
      const ref = await saveContextFile(sessionId, createSource.issue.markdown);
      if (ref !== null) {
        finalInput = {
          ...input,
          fileRefs: [
            ...input.fileRefs,
            { relPath: ref.relPath, absPath: ref.absPath, kind: "file" },
          ],
        };
      }
    }
    if (opts.asGoal && goalSupported) {
      void send(sessionId, finalInput, { asGoal: true });
    } else {
      useMessagesStore.getState().queue(sessionId, finalInput);
      // With no worktree there's nothing to wait for — flush now. With a
      // worktree, the setup stream flushes the queue on its terminal status —
      // UNLESS setup already finished (a reused "In use" worktree, or an eager
      // checkout that completed before this send), in which case that event has
      // already passed, so flush manually.
      const setupDone =
        worktreeId === null ||
        (() => {
          const wt = (
            useWorktreesStore.getState().byProject[selectedFolderId] ??
            EMPTY_WORKTREES
          ).find((w) => w.id === worktreeId);
          return (
            wt === undefined ||
            wt.setupStatus === "succeeded" ||
            wt.setupStatus === "skipped" ||
            wt.setupStatus === "failed"
          );
        })();
      if (setupDone) {
        useMessagesStore.getState().flushQueue(sessionId);
      }
    }
    setCreateSource(null);
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
              hasWorktree:
                pendingWorktreeId !== null || defaultAutoCreateWorktree,
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
            composerDraftKey={composerDraftKeyForLanding(selectedFolderId)}
            onDraftSubmit={(input, opts) => void handleDraftSubmit(input, opts)}
            headerSlot={
              <div className="flex items-center gap-1.5">
                {createSource !== null && (
                  <span className="flex items-center gap-1 rounded-md bg-muted/60 py-1 pl-2 pr-1 text-[11px] text-muted-foreground">
                    {createSource.kind === "issue" ? (
                      <span>Issue {createSource.label} attached</span>
                    ) : (
                      <span className="max-w-[16rem] truncate">
                        {createSource.label}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setCreateSource(null)}
                      aria-label="Clear create-from source"
                      className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3" strokeWidth={2} />
                    </button>
                  </span>
                )}
                {creatingSource && (
                  <Spinner className="size-3.5 text-muted-foreground" />
                )}
                <CreateFromMenu
                  folderId={selectedFolderId}
                  onSelect={(sel) => void handleCreateFromSelect(sel)}
                />
              </div>
            }
          />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            Pick a project below to start a new chat.
          </p>
        )}

        <ContinueThreadsSection
          threads={externalThreads}
          loading={externalThreadsLoading}
          continuingId={continuingExternalThreadId}
          onContinue={(thread) => void continueExternalThread(thread)}
        />

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

function ContinueThreadsSection({
  threads,
  loading,
  continuingId,
  onContinue,
}: {
  threads: ReturnType<typeof useExternalThreadsStore.getState>["threads"];
  loading: boolean;
  continuingId: string | null;
  onContinue: (
    thread: ReturnType<
      typeof useExternalThreadsStore.getState
    >["threads"][number],
  ) => void;
}) {
  if (!loading && threads.length === 0) return null;
  return (
    <section className="mt-2 min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <span>Continue Threads</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tracking-normal text-muted-foreground">
            {loading && threads.length === 0 ? "..." : threads.length}
          </span>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {loading && threads.length === 0
          ? Array.from({ length: 3 }).map((_, index) => (
              <ContinueThreadSkeleton
                // eslint-disable-next-line react/no-array-index-key
                key={index}
              />
            ))
          : threads.map((thread) => {
              const disabled = !thread.available || continuingId !== null;
              const active = continuingId === thread.id;
              return (
                <button
                  type="button"
                  key={thread.id}
                  disabled={disabled}
                  onClick={() => onContinue(thread)}
                  title={
                    thread.available
                      ? thread.projectPath
                      : `${thread.projectPath || "Project folder"} is missing`
                  }
                  className={cn(
                    "group min-w-[17.5rem] max-w-[19rem] text-left outline-none transition-transform focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring",
                    !disabled && "hover:-translate-y-px",
                    disabled && "cursor-default hover:translate-y-0",
                  )}
                >
                  <Frame
                    className={cn(
                      "h-40 min-w-[17.5rem] overflow-hidden bg-muted/50 p-1 transition-colors",
                      !thread.available && "opacity-55",
                    )}
                  >
                    <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-1.5">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-xs/5">
                          <ProviderIcon
                            providerId={thread.providerId}
                            className="size-4"
                          />
                        </span>
                        <FrameTitle className="truncate text-[11px] font-medium text-muted-foreground">
                          {providerThreadLabel(thread.providerId)}
                        </FrameTitle>
                      </div>
                      {active ? (
                        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatThreadRelative(thread.updatedAt)}
                        </span>
                      )}
                    </FrameHeader>
                    <FramePanel
                      className={cn(
                        "min-h-0 flex-1 overflow-hidden px-3 py-2 transition-colors",
                        !disabled &&
                          "group-hover:border-border group-hover:bg-muted/20",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                          {thread.title}
                        </div>
                        <div className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                          {thread.preview}
                        </div>
                      </div>
                    </FramePanel>
                    <FrameFooter className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <HugeiconsIcon
                          icon={Folder01Icon}
                          className="size-3.5 shrink-0"
                        />
                        <span className="truncate">{thread.projectName}</span>
                      </span>
                      {!thread.available && (
                        <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                          Missing
                        </span>
                      )}
                    </FrameFooter>
                  </Frame>
                </button>
              );
            })}
      </div>
    </section>
  );
}

function providerThreadLabel(providerId: ProviderId): string {
  if (providerId === "claude") return "Claude Code";
  if (providerId === "codex") return "Codex";
  return PROVIDER_LABEL[providerId] ?? providerId;
}

function ContinueThreadSkeleton() {
  return (
    <Frame className="h-40 min-w-[17.5rem] bg-muted/50 p-1">
      <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-3 w-8" />
      </FrameHeader>
      <FramePanel className="min-h-0 flex-1 px-3 py-2">
        <div>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-2 h-4 w-36" />
          <Skeleton className="mt-3 h-3 w-52" />
          <Skeleton className="mt-1.5 h-3 w-40" />
        </div>
      </FramePanel>
      <FrameFooter className="flex items-center gap-1.5 px-3 py-2">
        <Skeleton className="size-3.5" />
        <Skeleton className="h-3 w-24" />
      </FrameFooter>
    </Frame>
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
