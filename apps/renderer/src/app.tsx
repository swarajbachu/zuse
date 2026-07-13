import { Effect } from "effect";
import { useEffect, useRef } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import { ArchivedChatsPage } from "./components/archived-chats-page.tsx";
import { ChatComposer } from "./components/chat-composer";
import { ChatLanding } from "./components/chat-landing.tsx";
import { ChatSwitcher } from "./components/chat-switcher.tsx";
import { ChatView } from "./components/chat-view";
import { CliUpgradeBanner } from "./components/cli-upgrade-banner.tsx";
import { CostFooter } from "./components/cost-footer";
import { EnvironmentSummary } from "./components/environment-summary.tsx";
import { FileEditor } from "./components/file-editor.tsx";
import { closeActiveChatTab, MainTabs } from "./components/main-tabs.tsx";
import { NotchTrayBridge } from "./components/notch-tray-bridge.tsx";
import { OnboardingWizard } from "./components/onboarding/onboarding-wizard.tsx";
import { ProjectsSidebar } from "./components/projects-sidebar";
import { ProviderUpdatesToast } from "./components/provider-updates-toast.tsx";
import { RightPane } from "./components/right-pane";
import { SettingsPage } from "./components/settings-page";
import {
  SidebarPeekOverlay,
  SidebarPeekTrigger,
} from "./components/sidebar-peek.tsx";
import { TopBarLeft, TopBarMain, TopBarRight } from "./components/top-bar.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { UpdateBanner } from "./components/update-banner.tsx";
import { UsageDashboard } from "./components/usage-dashboard.tsx";
import { useKeybindingDispatch } from "./hooks/use-keybinding-dispatch.ts";
import { useMediaQuery } from "./hooks/use-media-query.ts";
import { useMenuShortcuts } from "./hooks/use-menu-shortcuts.ts";
import { useReportRunningAgents } from "./hooks/use-report-running-agents.ts";
import { AppearanceController } from "./lib/appearance.tsx";
import { getRpcClient } from "./lib/rpc-client.ts";
import { useAuthStore } from "./store/auth.ts";
import { useKeybindingsStore } from "./store/keybindings.ts";
import { usePermissionsStore } from "./store/permissions.ts";
import { useProvidersStore } from "./store/providers.ts";
import { useSessionsStore } from "./store/sessions.ts";
import { useSettingsStore } from "./store/settings.ts";
import { useUiStore } from "./store/ui.ts";
import { useWorkspaceStore } from "./store/workspace.ts";
import { useWorktreesStore } from "./store/worktrees.ts";

const PANEL_GROUP_ID = "zuse.shell.v3";
const PANEL_IDS = ["projects", "main", "files"];

const SIDEBAR_ANIM_MS = 150;
const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

/**
 * Animate a collapsible side panel open/closed by driving the library's own
 * imperative `resize()` in a rAF tween, instead of a CSS transition.
 *
 * react-resizable-panels controls panel widths via inline flex styles and a
 * ResizeObserver; a CSS transition on those fights that observer (the panel
 * snaps back / won't collapse). Calling `resize()` each frame keeps the
 * library's model authoritative the whole way, so it stays smooth and always
 * lands in the exact end state (`collapse()` when closed, the remembered width
 * when open). The first run after mount snaps without animating so a restored
 * layout doesn't slide in.
 */
function useAnimatedPanelCollapse(
  panelRef: ReturnType<typeof usePanelRef>,
  open: boolean,
  defaultPct: number,
  animatingRef: { current: boolean },
) {
  const rafRef = useRef<number | null>(null);
  const lastOpenPct = useRef(defaultPct);
  const didInit = useRef(false);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    const cancel = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      animatingRef.current = false;
    };

    // First run: snap to the correct state (no animation) so a persisted
    // layout doesn't animate in on launch.
    if (!didInit.current) {
      didInit.current = true;
      const collapsed = panel.isCollapsed();
      if (!collapsed) {
        lastOpenPct.current = panel.getSize().asPercentage || defaultPct;
      }
      if (open && collapsed) panel.expand();
      if (!open && !collapsed) panel.collapse();
      return;
    }

    cancel();

    const startPct = panel.getSize().asPercentage;
    // Remember the width we're collapsing from so reopening restores it.
    if (!open && startPct > 0) lastOpenPct.current = startPct;
    const targetPct = open ? lastOpenPct.current || defaultPct : 0;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (open) {
        if (panel.isCollapsed()) panel.expand();
        panel.resize(`${targetPct}%`);
      } else {
        panel.collapse();
      }
      return;
    }

    if (Math.abs(startPct - targetPct) < 0.05) {
      if (!open && !panel.isCollapsed()) panel.collapse();
      return;
    }

    // Suppress the panel's onResize→store sync while we drive resize()
    // ourselves, otherwise an intermediate (size > 0) frame would flip the
    // store back open mid-collapse and fight this tween.
    animatingRef.current = true;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / SIDEBAR_ANIM_MS);
      const v = startPct + (targetPct - startPct) * easeOutQuart(t);
      panel.resize(`${v}%`);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      rafRef.current = null;
      // Settle into the exact end state so the collapsed flag / peek logic
      // stay correct.
      if (open) panel.resize(`${targetPct}%`);
      else panel.collapse();
      animatingRef.current = false;
    };
    rafRef.current = requestAnimationFrame(tick);

    return cancel;
  }, [panelRef, open, defaultPct, animatingRef]);
}

/**
 * Root component. Owns only the cross-cutting concerns that need to run in
 * every mode (permissions stream, fullscreen sync, onboarding gate). The
 * heavy three-pane shell lives in `MainShell` so its layout hooks don't
 * initialize while the onboarding wizard is on screen — re-mounting it on
 * exit is what gives us a clean shell each time.
 */
export function App() {
  // Cross-cutting subscriptions that should run regardless of view.
  const startPermissionsStream = usePermissionsStore((s) => s.start);
  useEffect(() => {
    startPermissionsStream();
  }, [startPermissionsStream]);

  // WorkOS auth: subscribe to session changes + cold-load the current session.
  // Optional (no gate) — the sidebar account control, onboarding step, and
  // settings panel all render off this state.
  const startAuthStream = useAuthStore((s) => s.start);
  const hydrateAuth = useAuthStore((s) => s.hydrate);
  useEffect(() => {
    startAuthStream();
    void hydrateAuth();
  }, [startAuthStream, hydrateAuth]);

  // Native Application Menu → renderer action dispatcher. Lives on the
  // root so the bindings work in every view (chat, settings, onboarding).
  useMenuShortcuts();

  // Document-level keybinding dispatcher. Walks the live keybindings store
  // on every keydown and fires the matching application command. Composer
  // and editor commands are handled by CodeMirror keymaps, so this hook
  // ignores them.
  useKeybindingDispatch();

  // Mirror the running-agent count to main so the before-quit guard and the
  // "quit/restart when idle" deferrals have a live value.
  useReportRunningAgents();

  // Hydrate settings + keybindings from the on-disk config store. Each call is
  // idempotent; subsequent emits flow through the RPC streams maintained by the
  // stores themselves.
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateKeybindings = useKeybindingsStore((s) => s.hydrate);
  useEffect(() => {
    void hydrateSettings();
    void hydrateKeybindings();
  }, [hydrateSettings, hydrateKeybindings]);

  // Probe provider availability once on boot so the "update available" launch
  // toast can fire without the user first opening settings. ProvidersPane
  // re-probes on mount while settings is open (it no longer re-polls on window
  // focus — that read the keychain and made macOS re-prompt on every refocus
  // for unsigned/dev builds).
  const loadProviders = useProvidersStore((s) => s.load);
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // Mirror Electron's fullscreen state into the ui store so the top bars
  // can drop the macOS traffic-light gutter.
  const setFullScreen = useUiStore((s) => s.setFullScreen);
  useEffect(() => {
    const win = window.zuse?.window;
    if (win === undefined) return;
    return win.onFullScreenChange((value) => setFullScreen(value));
  }, [setFullScreen]);

  // One-shot RPC ping so we know the bridge is alive early. Only the failure
  // is logged — the success path is silent to keep the renderer console clean.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await getRpcClient();
        await Effect.runPromise(client["ping.ping"]({}));
      } catch (error) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[zuse] RPC smoke test failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const view = useUiStore((s) => s.view);

  if (!onboardingCompleted) {
    return (
      <TooltipProvider>
        <NotchTrayBridge />
        <AppearanceController />
        <div className="relative flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
          <OnboardingWizard />
        </div>
      </TooltipProvider>
    );
  }

  if (view === "settings") {
    return (
      <TooltipProvider>
        <NotchTrayBridge />
        <AppearanceController />
        <div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden bg-background text-foreground">
          <SettingsPage />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <NotchTrayBridge />
      <AppearanceController />
      <MainShell />
    </TooltipProvider>
  );
}

/**
 * The three-pane chat shell. Owns its own layout/panel hooks so they
 * initialize on mount (i.e. only after onboarding is past). Re-mounting
 * this component on every onboarding exit guarantees the layout starts
 * from a clean state.
 */
function MainShell() {
  const folders = useWorkspaceStore((s) => s.folders);
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
  const selectedSession = useSessionsStore((s) => {
    if (s.selectedSessionId === null) return null;
    for (const list of Object.values(s.sessionsByProject)) {
      const match = list.find((session) => session.id === s.selectedSessionId);
      if (match !== undefined) return match;
    }
    return null;
  });
  const selectedFolder = selectedFolderId
    ? (folders.find((f) => f.id === selectedFolderId) ?? null)
    : null;

  const activeMainTab = useUiStore((s) => s.activeMainTab);
  const usageScope = useUiStore((s) => s.usageScope);
  const openFile = useUiStore((s) => s.openFile);
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
  const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
  const setRightSidebarOpen = useUiStore((s) => s.setRightSidebarOpen);
  const isFullScreen = useUiStore((s) => s.isFullScreen);
  const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
  const environmentSummaryFits = useMediaQuery({ min: 1180 });
  const environmentSummaryAvailable =
    isFullScreen &&
    environmentSummaryFits &&
    selectedSessionId !== null &&
    activeMainTab === "chat";
  const showEnvironmentSummary =
    environmentSummaryAvailable &&
    environmentSummaryOpen &&
    !rightSidebarOpen;

  // Switching projects closes the file tab — its path wouldn't resolve
  // under the new project's root anyway.
  useEffect(() => {
    if (openFile === null) return;
    if (openFile.kind !== "text") return;
    if (selectedFolderId !== null && openFile.folderId === selectedFolderId) {
      return;
    }
    closeFileTab();
  }, [selectedFolderId, openFile, closeFileTab]);

  // Eagerly hydrate worktrees on project select so the active context can
  // resolve worktree paths without waiting for the chat composer to mount.
  // Without this, terminal/file-tree/branch label stay in "preparing
  // worktree" until the user opens the chat tab.
  const refreshWorktrees = useWorktreesStore((s) => s.refresh);
  useEffect(() => {
    if (selectedFolderId === null) return;
    void refreshWorktrees(selectedFolderId);
  }, [selectedFolderId, refreshWorktrees]);

  // Cmd+W in the menu dispatches `menu:close-tab` over IPC; the renderer
  // owns the close-tab logic because it knows which surface is active. If
  // the file tab is foregrounded we close that; otherwise we fall through
  // to the chat-tab archive path.
  useEffect(() => {
    const menu = window.zuse?.menu;
    if (menu === undefined) return;
    return menu.onCloseTab(() => {
      const { activeMainTab, closeFileTab, openFile } = useUiStore.getState();
      if (activeMainTab === "file" && openFile !== null) {
        closeFileTab();
        return;
      }
      void closeActiveChatTab();
    });
  }, []);

  const emptyTabLabel = selectedFolder
    ? selectedFolder.name
    : "no project selected";

  // The empty new-chat landing reads as a clean, chrome-free surface: no top
  // bar, no tab strip — just the centered composer. Keep the chrome whenever a
  // session/file is open, or when the left panel is collapsed (so the user
  // always has a way back to the projects panel + the window drag region).
  const showMainChrome =
    selectedSessionId !== null || openFile !== null || !leftSidebarOpen;

  // Persist the three-pane layout in localStorage so widths survive reloads.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: PANEL_GROUP_ID,
    panelIds: PANEL_IDS,
    storage: typeof window === "undefined" ? undefined : window.localStorage,
  });

  // Drive the side panels' collapsed state from `useUiStore`, animating the
  // open/close via the library's imperative resize() (see the hook). v4 has no
  // `onCollapse` prop — we peek the imperative handle through `panelRef`.
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const leftAnimating = useRef(false);
  const rightAnimating = useRef(false);
  useAnimatedPanelCollapse(leftPanelRef, leftSidebarOpen, 18, leftAnimating);
  useAnimatedPanelCollapse(rightPanelRef, rightSidebarOpen, 22, rightAnimating);

  return (
    <div className="flex h-dvh max-h-dvh min-h-0 w-screen overflow-hidden text-foreground">
      <Group
        id={PANEL_GROUP_ID}
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-1"
      >
        <Panel
          id="projects"
          defaultSize="20%"
          // minSize 0 so the open/close tween can rest at any width down to 0
          // — the library otherwise snaps sub-minSize widths to minSize/0,
          // which turns the last stretch of the animation into a hard jump.
          minSize="0px"
          maxSize="40%"
          collapsible
          collapsedSize="0%"
          panelRef={leftPanelRef}
          onResize={(size) => {
            if (leftAnimating.current) return;
            const open = size.asPercentage > 0;
            if (open !== leftSidebarOpen) setLeftSidebarOpen(open);
          }}
        >
          <div className="flex h-full min-h-0 flex-col bg-background/40">
            <TopBarLeft />
            <div className="flex min-h-0 flex-1 flex-col">
              <ProjectsSidebar />
            </div>
          </div>
        </Panel>
        <Separator className="w-px bg-border transition-colors hover:bg-foreground/20 active:bg-foreground/30" />
        <Panel id="main" minSize="30%">
          <main className="flex h-full min-h-0 min-w-0 flex-col bg-background">
            {showMainChrome ? <TopBarMain /> : null}
            <UpdateBanner />
            <ProviderUpdatesToast />
            {showMainChrome ? (
              <MainTabs
                projectId={selectedFolderId}
                emptyLabel={emptyTabLabel}
              />
            ) : null}
            <div
              hidden={activeMainTab !== "chat"}
              className="flex min-h-0 flex-1 flex-col"
            >
              {selectedSessionId !== null && selectedSession !== null ? (
                // Render the chat as soon as the session exists — even while
                // its worktree is still branching or the provider is booting.
                // All that progress is surfaced inline by `WorktreeSetupCard`
                // at the top of the timeline, with the composer pinned at the
                // bottom (no full-screen takeover).
                <div className="flex min-h-0 min-w-0 flex-1 px-3">
                  <div className="mx-auto flex min-h-0 min-w-0 w-full max-w-4xl flex-1 flex-col">
                    <ChatView sessionId={selectedSessionId} />
                    <CostFooter
                      sessionId={selectedSessionId}
                      constrain={false}
                    />
                    <CliUpgradeBanner
                      providerId={selectedSession.providerId}
                      constrain={false}
                    />
                    <ChatComposer
                      key={selectedSession.id}
                      session={selectedSession}
                      constrain={false}
                    />
                  </div>
                  {environmentSummaryAvailable ? (
                    <div
                      className={`shrink-0 overflow-hidden transition-[width,opacity] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
                        showEnvironmentSummary
                          ? "w-[18.75rem] opacity-100"
                          : "w-0 opacity-0"
                      }`}
                      aria-hidden={!showEnvironmentSummary}
                      inert={!showEnvironmentSummary}
                    >
                      <div
                        className={`w-[18.75rem] transition-transform duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] motion-reduce:transition-none ${
                          showEnvironmentSummary
                            ? "translate-x-0"
                            : "translate-x-3"
                        }`}
                      >
                        <EnvironmentSummary />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <ChatLanding />
              )}
            </div>
            <div
              hidden={activeMainTab !== "archives"}
              className="flex min-h-0 flex-1 flex-col"
            >
              {activeMainTab === "archives" && (
                <ArchivedChatsPage
                  projectId={selectedFolderId}
                  projectName={selectedFolder?.name ?? "No repository selected"}
                />
              )}
            </div>
            <div
              hidden={activeMainTab !== "usage"}
              className="flex min-h-0 flex-1 flex-col"
            >
              {activeMainTab === "usage" && (
                <UsageDashboard
                  projectId={usageScope === "project" ? selectedFolderId : null}
                  availableProjectId={selectedFolderId}
                  scopeLabel={
                    usageScope === "project"
                      ? (selectedFolder?.name ?? "This project")
                      : "All projects"
                  }
                />
              )}
            </div>
            {openFile !== null && (
              <div
                hidden={activeMainTab !== "file"}
                className="flex min-h-0 flex-1 flex-col"
              >
                <FileEditor />
              </div>
            )}
          </main>
        </Panel>
        <Separator className="w-px bg-border transition-colors hover:bg-foreground/20 active:bg-foreground/30" />
        <Panel
          id="files"
          defaultSize="22%"
          // minSize 0 so the open/close tween stays smooth all the way to 0
          // (see the left panel note).
          minSize="0px"
          maxSize="55%"
          collapsible
          collapsedSize="0%"
          panelRef={rightPanelRef}
          onResize={(size, _id, prev) => {
            if (rightAnimating.current) return;
            // Ignore the initial mount call (prev === undefined). The right
            // dock defaults to closed (`rightSidebarOpen: false`); the
            // persisted/default panel width would otherwise fire here and
            // flip the sidebar open before the collapse effect runs.
            if (prev === undefined) return;
            const open = size.asPercentage > 0;
            if (open !== rightSidebarOpen) setRightSidebarOpen(open);
          }}
        >
          <div className="flex h-full min-h-0 flex-col bg-background/20">
            <TopBarRight />
            <div className="flex min-h-0 flex-1 flex-col">
              <RightPane />
            </div>
          </div>
        </Panel>
      </Group>
      <SidebarPeekTrigger />
      <SidebarPeekOverlay />
      <ChatSwitcher />
    </div>
  );
}
