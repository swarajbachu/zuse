import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  GlobeIcon,
  PencilIcon,
  Shield01Icon,
  TerminalIcon,
  Wrench01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { useEffect, useMemo, useState } from "react";

import type { FolderId, PermissionKind, SavedDecision } from "@memoize/wire";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { usePermissionsStore } from "../store/permissions.ts";

const kindIcon = (kind: PermissionKind) => {
  switch (kind._tag) {
    case "Bash":
      return (
        <HugeiconsIcon
          icon={TerminalIcon}
          className="size-3.5 text-amber-300"
        />
      );
    case "FileWrite":
      return (
        <HugeiconsIcon
          icon={PencilIcon}
          className="size-3.5 text-emerald-300"
        />
      );
    case "Network":
      return (
        <HugeiconsIcon icon={GlobeIcon} className="size-3.5 text-sky-300" />
      );
    case "Other":
      return (
        <HugeiconsIcon icon={Wrench01Icon} className="size-3.5 text-zinc-300" />
      );
  }
};

const kindLabel = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "Bash":
      return kind.command;
    case "FileWrite":
      return kind.path;
    case "Network":
      return kind.url;
    case "Other":
      return `${kind.tool} — ${kind.summary}`;
  }
};

const decisionStyles = (decision: SavedDecision["decision"]): string => {
  switch (decision) {
    case "AlwaysAllow":
      return "bg-violet-500/22 text-violet-100 ring-1 ring-inset ring-violet-300/10";
    case "AllowForSession":
      return "bg-emerald-500/22 text-emerald-100 ring-1 ring-inset ring-emerald-300/10";
    case "AllowOnce":
      return "bg-zinc-500/25 text-zinc-100 ring-1 ring-inset ring-zinc-300/10";
    case "Deny":
      return "bg-red-500/22 text-red-100 ring-1 ring-inset ring-red-300/10";
  }
};

const formatDate = (d: Date): string => {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return d.toLocaleDateString();
};

interface PermissionsInspectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: FolderId;
  projectName: string;
}

/**
 * Modal listing permission decisions saved against one project. Decisions are
 * grouped by scope: folder (`AlwaysAllow`) shows up top, session-scoped
 * `AllowForSession` rows below, and any persisted `AllowOnce`/`Deny` rows
 * collapsed under "Recent activity". Revoke deletes the row so the next
 * matching tool call re-prompts.
 */
export function PermissionsInspector({
  open,
  onOpenChange,
  projectId,
  projectName,
}: PermissionsInspectorProps) {
  const decisionsByProject = usePermissionsStore((s) => s.decisionsByProject);
  const loadingByProject = usePermissionsStore(
    (s) => s.loadingDecisionsByProject,
  );
  const loadDecisions = usePermissionsStore((s) => s.loadDecisions);
  const revoke = usePermissionsStore((s) => s.revoke);

  const decisions = decisionsByProject[projectId] ?? [];
  const loading = loadingByProject[projectId] === true;

  // Reload every time the modal opens — the user may have hit a prompt
  // outside this surface and we want fresh state.
  useEffect(() => {
    if (open) void loadDecisions(projectId);
  }, [open, projectId, loadDecisions]);

  const grouped = useMemo(() => {
    const folder: SavedDecision[] = [];
    const session: SavedDecision[] = [];
    const recent: SavedDecision[] = [];
    for (const d of decisions) {
      if (d.scope === "folder" && d.decision === "AlwaysAllow") folder.push(d);
      else if (d.scope === "session" && d.decision === "AllowForSession")
        session.push(d);
      else recent.push(d);
    }
    return { folder, session, recent };
  }, [decisions]);

  const [showSession, setShowSession] = useState(true);
  const [showRecent, setShowRecent] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl" showCloseButton>
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <HugeiconsIcon
              icon={Shield01Icon}
              className="size-4 text-violet-300"
            />
            <DialogTitle className="text-base">
              Permissions — {projectName}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogPanel className="text-sm">
          {loading && decisions.length === 0 ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : decisions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No saved permission decisions for this project yet. They appear
              here when you click &quot;Allow for session&quot; or &quot;Always
              allow in project&quot; on a permission prompt.
            </p>
          ) : (
            <>
              <Section
                title="Always allowed in this project"
                decisions={grouped.folder}
                onRevoke={(id) => void revoke(projectId, id)}
                emptyHint="No project-wide allowances yet."
              />
              <button
                type="button"
                onClick={() => setShowSession((v) => !v)}
                className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {showSession ? "▾" : "▸"} Allowed for past sessions (
                {grouped.session.length})
              </button>
              {showSession && (
                <Section
                  title=""
                  decisions={grouped.session}
                  onRevoke={(id) => void revoke(projectId, id)}
                  emptyHint="No session-scoped allowances."
                />
              )}
              <button
                type="button"
                onClick={() => setShowRecent((v) => !v)}
                className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {showRecent ? "▾" : "▸"} Recent activity (
                {grouped.recent.length})
              </button>
              {showRecent && (
                <Section
                  title=""
                  decisions={grouped.recent}
                  onRevoke={(id) => void revoke(projectId, id)}
                  emptyHint="No recent prompts."
                />
              )}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function Section({
  title,
  decisions,
  onRevoke,
  emptyHint,
}: {
  title: string;
  decisions: ReadonlyArray<SavedDecision>;
  onRevoke: (requestId: string) => void;
  emptyHint: string;
}) {
  if (title === "" && decisions.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">{emptyHint}</p>
    );
  }
  return (
    <div className={title === "" ? "mt-2" : "mt-4"}>
      {title !== "" ? (
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      ) : null}
      {decisions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {decisions.map((d) => (
            <DecisionRow key={d.requestId} decision={d} onRevoke={onRevoke} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionRow({
  decision,
  onRevoke,
}: {
  decision: SavedDecision;
  onRevoke: (requestId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <span className="shrink-0">{kindIcon(decision.kind)}</span>
      <span
        className="flex-1 truncate font-mono text-xs text-foreground"
        title={kindLabel(decision.kind)}
      >
        {kindLabel(decision.kind)}
      </span>
      <span
        className={`rounded-[0.1875rem] px-1.5 py-0.5 text-[10px] ${decisionStyles(
          decision.decision,
        )}`}
      >
        {decision.decision}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {formatDate(decision.decidedAt)}
      </span>
      {confirming ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onRevoke(decision.requestId);
              setConfirming(false);
            }}
            className="rounded bg-red-500/30 px-2 py-0.5 text-[10px] text-red-100 hover:bg-red-500/50"
          >
            Revoke
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded p-1 text-muted-foreground hover:bg-red-500/20 hover:text-red-200"
          aria-label="Revoke"
          title="Revoke this decision"
        >
          <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
        </button>
      )}
    </li>
  );
}
