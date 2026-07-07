import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Database01Icon,
  Login03Icon,
  Loading02Icon,
  MoreVerticalIcon,
  RocketIcon,
  WrenchIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { useEffect, useRef, useState } from "react";
import { Effect, Fiber, Stream } from "effect";

import type {
  DeployDetection,
  Deployment,
  DeployStatus,
  FolderId,
  WorktreeId,
} from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";
import {
  formatRelativeTime,
  useRelativeTimeTick,
} from "../lib/use-relative-time.ts";
import { useAuth } from "../hooks/use-auth.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useBrowserNavStore } from "../store/browser-nav.ts";
import { deployKey, useDeployStore } from "../store/deploy.ts";
import { useMessagesStore } from "../store/messages.ts";
import { useUiStore } from "../store/ui.ts";
import { Button } from "./ui/button.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu.tsx";
import { toastManager } from "./ui/toast.tsx";

const RUNNING_STATUSES: ReadonlySet<DeployStatus> = new Set([
  "queued",
  "detecting",
  "convex_provisioning",
  "convex_deploying",
  "collecting",
  "uploading",
  "building",
]);

export const isDeployRunning = (status: DeployStatus): boolean =>
  RUNNING_STATUSES.has(status);

const STATUS_LABEL: Record<DeployStatus, string> = {
  queued: "Queued",
  detecting: "Detecting",
  convex_provisioning: "Provisioning Convex",
  convex_deploying: "Deploying Convex",
  collecting: "Collecting files",
  uploading: "Uploading",
  building: "Building",
  ready: "Live",
  failed: "Failed",
  canceled: "Canceled",
};

export const deployStatusLabel = (status: DeployStatus): string =>
  STATUS_LABEL[status];

const FRAMEWORK_LABEL: Record<DeployDetection["framework"], string> = {
  nextjs: "Next.js",
  vite: "Vite",
  astro: "Astro",
  unknown: "Auto-detect",
};

const errorMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const tagged = err as { _tag?: string; reason?: string };
    if (tagged._tag === "ConvexAuthRequiredError") {
      return "Connect Convex to deploy this project.";
    }
    if (tagged._tag === "DeployAlreadyRunningError") {
      return "A deploy is already running.";
    }
    if (typeof tagged.reason === "string") return tagged.reason;
  }
  if (err instanceof Error) return err.message;
  return String(err);
};

/**
 * Section card chrome shared by the Publish / Backend cards: icon tile on
 * the left, kicker + title + description, action on the right — the layout
 * language of setup cards (see the feature spec's UI section).
 */
function SectionCard({
  icon,
  kicker,
  badge,
  title,
  description,
  action,
  children,
}: {
  icon: React.ReactNode;
  kicker: string;
  badge?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="shrink-0 rounded-xl border border-border/60 bg-card/50">
      <div className="flex items-center gap-3 px-3 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              {kicker}
            </span>
            {badge}
          </div>
          <div className="truncate text-[13px] font-semibold text-foreground">
            {title}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {description}
          </div>
        </div>
        {action !== undefined ? (
          <div className="shrink-0">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted/70 px-1.5 py-px text-[9px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

const statusDotClass = (status: DeployStatus): string =>
  status === "ready"
    ? "bg-emerald-500"
    : status === "failed"
      ? "bg-red-500"
      : isDeployRunning(status)
        ? "bg-amber-500 animate-pulse"
        : "bg-zinc-500";

/**
 * Deploy panel (singleton right-pane dock tab). Three stacked cards —
 * Publish (Vercel), Backend (Convex, always visible so the connect flow is
 * discoverable even before a convex/ dir exists), and the live build log —
 * plus per-project history. Owns the `deploy.events` stream subscription
 * for its (folder, worktree); the top-bar chip reads the same store.
 */
export function DeployPane({
  folderId,
  worktreeId,
}: {
  folderId: FolderId;
  worktreeId: WorktreeId | null;
}) {
  const key = deployKey(folderId, worktreeId);
  const entry = useDeployStore((s) => s.byKey[key] ?? null);
  const convexConnection = useDeployStore((s) => s.convexConnection);
  const { isSignedIn, isLoading: authLoading, signingIn, signIn } = useAuth();
  const [detection, setDetection] = useState<DeployDetection | null>(null);
  const [starting, setStarting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  useRelativeTimeTick();

  const latest = entry?.latest ?? null;
  const log = entry?.log ?? "";
  const history = entry?.history ?? [];
  const running = latest !== null && isDeployRunning(latest.status);

  // Live event subscription — seeds the latest snapshot + any active log,
  // then streams. Same lifecycle pattern as browser-pane's command stream.
  useEffect(() => {
    let cancelled = false;
    let fiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    void (async () => {
      const client = await getRpcClient();
      if (cancelled) return;
      fiber = Effect.runFork(
        Stream.runForEach(
          client.deploy.events({ folderId, worktreeId }),
          (event) =>
            Effect.sync(() => {
              useDeployStore.getState().applyEvent(key, event);
            }),
        ),
      );
    })();
    void useDeployStore.getState().refreshHistory(folderId, worktreeId);
    void useDeployStore.getState().refreshConvexStatus();
    return () => {
      cancelled = true;
      if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
    };
  }, [folderId, worktreeId, key]);

  // Detection is cheap and read-only — refresh whenever the panel targets a
  // different checkout so the framework label / Convex badge stay truthful.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await getRpcClient();
        const result = await Effect.runPromise(
          client.deploy.detect({ folderId, worktreeId }),
        );
        if (!cancelled) setDetection(result);
      } catch {
        if (!cancelled) setDetection(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, worktreeId]);

  // Pin the log to the bottom as it streams.
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [log]);

  const needsConvexConnect =
    detection?.hasConvex === true && convexConnection === null;
  const needsZuseSignIn = !authLoading && !isSignedIn;

  const startDeploy = async () => {
    if (starting || running) return;
    if (needsZuseSignIn) {
      toastManager.add({
        type: "info",
        title: "Sign in required",
        description: "Sign in to Zuse before publishing.",
      });
      await signIn();
      return;
    }
    setStarting(true);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.deploy.start({ folderId, worktreeId }));
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Deploy failed to start",
        description: errorMessage(err),
      });
    } finally {
      setStarting(false);
    }
  };

  const cancelDeploy = async () => {
    if (latest === null) return;
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.deploy.cancel({ deploymentId: latest.id }),
      );
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Cancel failed",
        description: errorMessage(err),
      });
    }
  };

  const connectConvex = async () => {
    if (connecting) return;
    if (needsZuseSignIn) {
      await signIn();
      return;
    }
    setConnecting(true);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.deploy.connectConvex({}));
      await useDeployStore.getState().refreshConvexStatus();
      toastManager.add({ type: "success", title: "Convex connected" });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Convex connection failed",
        description: errorMessage(err),
      });
    } finally {
      setConnecting(false);
    }
  };

  const disconnectConvex = async () => {
    try {
      await useDeployStore.getState().disconnectConvex();
      toastManager.add({ type: "info", title: "Convex disconnected" });
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Disconnect failed",
        description: errorMessage(err),
      });
    }
  };

  const openUrl = (url: string) => {
    useBrowserNavStore.getState().navigateTo(url);
    useUiStore.getState().revealPanel("browser");
  };

  const publishDescription =
    detection === null
      ? "Build and publish this project to a zuse.app URL."
      : `${FRAMEWORK_LABEL[detection.framework]} build → published on zuse.app`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
      {/* ---- Publish card (Vercel) ---- */}
      <SectionCard
        icon={
          <HugeiconsIcon
            icon={RocketIcon}
            className="size-4.5 text-muted-foreground"
          />
        }
        kicker="Frontend"
        badge={
          latest !== null && isDeployRunning(latest.status) ? (
            <Pill>{STATUS_LABEL[latest.status]}</Pill>
          ) : undefined
        }
        title="Publish to web"
        description={publishDescription}
        action={
          running ? (
            <Button variant="outline" size="sm" onClick={() => void cancelDeploy()}>
              <HugeiconsIcon icon={Cancel01Icon} />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void startDeploy()}
              disabled={starting || authLoading || needsConvexConnect}
            >
              {starting ? (
                <HugeiconsIcon icon={Loading02Icon} className="animate-spin" />
              ) : (
                <HugeiconsIcon icon={RocketIcon} />
              )}
              {starting ? "Starting…" : "Deploy"}
            </Button>
          )
        }
      >
        {latest !== null ? (
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
            <span
              className={`size-1.5 shrink-0 rounded-full ${statusDotClass(latest.status)}`}
            />
            <span className="text-[11px] font-medium text-foreground/90">
              {STATUS_LABEL[latest.status]}
            </span>
            <span className="text-[10px] text-muted-foreground/70">
              {formatRelativeTime(latest.createdAt.getTime())}
            </span>
            {latest.url !== null ? (
              <button
                type="button"
                onClick={() => openUrl(latest.url ?? "")}
                className="ml-auto flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                title={latest.url}
              >
                <span className="truncate">
                  {latest.url.replace(/^https:\/\//, "")}
                </span>
                <HugeiconsIcon
                  icon={ArrowUpRight01Icon}
                  className="size-3 shrink-0"
                />
              </button>
            ) : null}
          </div>
        ) : null}
        {detection !== null && detection.warnings.length > 0 ? (
          <div className="border-t border-border/50 px-3 py-2">
            {detection.warnings.map((warning) => (
              <div
                key={warning}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <HugeiconsIcon
                  icon={Alert02Icon}
                  className="size-3 shrink-0"
                />
                {warning}
              </div>
            ))}
          </div>
        ) : null}
      </SectionCard>

      {/* ---- Backend card (Convex) — always visible so the connect flow is
             discoverable before the project even uses Convex. ---- */}
      <SectionCard
        icon={
          <HugeiconsIcon
            icon={Database01Icon}
            className="size-4.5 text-muted-foreground"
          />
        }
        kicker="Backend"
        badge={
          detection?.hasConvex === true ? (
            <Pill>Detected</Pill>
          ) : (
            <Pill>Optional</Pill>
          )
        }
        title="Convex"
        description={
          needsZuseSignIn
            ? "Sign in to Zuse before connecting your Convex team"
            : "Realtime data and functions — deploys to your own Convex team"
        }
        action={
          convexConnection === null ? (
            <Button
              size="sm"
              onClick={() => void connectConvex()}
              disabled={connecting || authLoading || signingIn}
            >
              {connecting || signingIn ? (
                <HugeiconsIcon icon={Loading02Icon} className="animate-spin" />
              ) : needsZuseSignIn ? (
                <HugeiconsIcon icon={Login03Icon} />
              ) : null}
              {signingIn
                ? "Signing in…"
                : connecting
                  ? "Waiting for browser…"
                  : needsZuseSignIn
                    ? "Sign in"
                    : "Connect"}
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  className="size-3.5"
                />
                {convexConnection.teamSlug ?? "Connected"}
              </span>
              <Menu>
                <MenuTrigger
                  className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-foreground/5 data-[popup-open]:bg-foreground/5"
                  aria-label="Convex options"
                >
                  <HugeiconsIcon
                    icon={MoreVerticalIcon}
                    className="size-3.5 text-muted-foreground"
                  />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-44">
                  <MenuItem onClick={() => void connectConvex()}>
                    Switch account
                  </MenuItem>
                  <MenuItem onClick={() => void disconnectConvex()}>
                    Disconnect
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          )
        }
      >
        {needsZuseSignIn ? (
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
            <HugeiconsIcon icon={Login03Icon} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Zuse sign-in is required before Convex authorization and deploy
              quota checks.
            </span>
          </div>
        ) : null}
      </SectionCard>

      {/* ---- Live build log ---- */}
      {log !== "" || running ? (
        <section className="flex min-h-32 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/50">
          <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              Build log
            </span>
            {running ? (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="size-3 animate-spin text-muted-foreground"
              />
            ) : null}
          </div>
          <pre
            ref={logRef}
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
          >
            {log === "" ? "Waiting for build output…" : log}
          </pre>
        </section>
      ) : null}

      {/* ---- History ---- */}
      {history.length > 0 ? (
        <section className="shrink-0 rounded-xl border border-border/60 bg-card/50">
          <div className="border-b border-border/50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
            History
          </div>
          <div className="max-h-44 overflow-y-auto">
            {history.map((deployment) => (
              <DeployHistoryRow
                key={deployment.id}
                deployment={deployment}
                folderId={folderId}
                worktreeId={worktreeId}
                onOpenUrl={openUrl}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DeployHistoryRow({
  deployment,
  folderId,
  worktreeId,
  onOpenUrl,
}: {
  deployment: Deployment;
  folderId: FolderId;
  worktreeId: WorktreeId | null;
  onOpenUrl: (url: string) => void;
}) {
  const ctx = useActiveContext();
  const sessionId = ctx.status === "ready" ? ctx.sessionId : null;

  const fixWithAgent = async () => {
    if (sessionId === null) {
      toastManager.add({
        type: "error",
        title: "No active session",
        description: "Open a chat to hand the failure to the agent.",
      });
      return;
    }
    const client = await getRpcClient();
    const failure = await Effect.runPromise(
      client.deploy.lastFailure({ folderId, worktreeId }),
    );
    if (failure === null) return;
    const message = [
      `The deploy failed${failure.phase === null ? "" : ` during the ${failure.phase} phase`}.`,
      failure.errorSummary === null ? null : `Error: ${failure.errorSummary}`,
      failure.logTail === null
        ? null
        : `Log tail:\n\`\`\`\n${failure.logTail}\n\`\`\``,
      "Please fix the problem; I'll redeploy after.",
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    await useMessagesStore.getState().send(sessionId, message);
    toastManager.add({ type: "info", title: "Sent failure to the agent" });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0">
      <span
        className={`size-1.5 shrink-0 rounded-full ${statusDotClass(deployment.status)}`}
      />
      <span className="text-[11px] text-muted-foreground">
        {STATUS_LABEL[deployment.status]}
      </span>
      <span className="text-[10px] text-muted-foreground/70">
        {formatRelativeTime(deployment.createdAt.getTime())}
      </span>
      {deployment.url !== null ? (
        <button
          type="button"
          onClick={() => onOpenUrl(deployment.url ?? "")}
          className="min-w-0 truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          title={deployment.url}
        >
          {deployment.url.replace(/^https:\/\//, "")}
        </button>
      ) : null}
      {deployment.status === "failed" ? (
        <button
          type="button"
          onClick={() => void fixWithAgent()}
          className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <HugeiconsIcon icon={WrenchIcon} className="size-3" />
          Fix with agent
        </button>
      ) : null}
    </div>
  );
}
