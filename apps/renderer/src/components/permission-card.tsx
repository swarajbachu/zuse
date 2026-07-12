import { useEffect } from "react";

import type {
  PermissionDecision,
  PermissionKind,
  PermissionRequest,
} from "@zuse/contracts";

import { cn } from "~/lib/utils";

import { usePermissionsStore } from "../store/permissions.ts";

const kindHeadline = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "Bash":
      return "Run shell command?";
    case "FileWrite":
      return "Write file?";
    case "Network":
      return "Make network request?";
    case "Other":
      return `Use tool ${kind.tool}?`;
  }
};

const kindDetail = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "Bash":
      return kind.command;
    case "FileWrite":
      return kind.path;
    case "Network":
      return kind.url;
    case "Other":
      return kind.summary;
  }
};

/**
 * `forcePrompt` is overloaded server-side: sensitive credential paths always
 * force a one-shot approval, but so does plan mode (every bash/write/network
 * call). The old copy always said "Sensitive path", which was wrong for the
 * common Grok/ACP case of plan-mode shell prompts on ordinary commands.
 */
const forcePromptHint = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "Bash":
    case "Network":
      // Bash policy never path-scans the command string — forcePrompt here is
      // plan mode (or an equivalent "never silence this class" gate).
      return "Plan mode — only “Allow once” is available.";
    case "FileWrite":
      return "Sensitive path or plan mode — only “Allow once” is available.";
    case "Other":
      return "Only “Allow once” is available for this request.";
  }
};

const ALLOW_ONCE: PermissionDecision = { _tag: "AllowOnce" };
const ALLOW_FOR_SESSION: PermissionDecision = { _tag: "AllowForSession" };
const ALWAYS_ALLOW_FOLDER: PermissionDecision = {
  _tag: "AlwaysAllow",
  scope: "folder",
};
const DENY: PermissionDecision = { _tag: "Deny" };

export function PermissionCard({
  head,
  queueSize,
}: {
  readonly head: PermissionRequest;
  readonly queueSize: number;
}) {
  const decide = usePermissionsStore((s) => s.decide);
  const persistentDisabled = head.forcePrompt;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void decide(head.id, DENY);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void decide(head.id, ALLOW_ONCE);
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [head.id, decide]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="text-base text-foreground truncate">
          {kindHeadline(head.kind)}
        </div>
        {queueSize > 1 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground shrink-0">
            +{queueSize - 1} more
          </span>
        ) : null}
      </div>

      <div className="mt-3 break-all rounded-md bg-muted/50 px-3 py-2 font-mono text-xs text-foreground/90">
        {kindDetail(head.kind)}
      </div>

      {persistentDisabled ? (
        <div className="mt-2 text-xs text-muted-foreground">
          {forcePromptHint(head.kind)}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => void decide(head.id, DENY)}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          title="Esc"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={persistentDisabled}
          onClick={() => void decide(head.id, ALLOW_FOR_SESSION)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors",
            persistentDisabled
              ? "pointer-events-none opacity-40"
              : "hover:bg-accent/40 hover:text-foreground",
          )}
        >
          For session
        </button>
        <button
          type="button"
          disabled={persistentDisabled}
          onClick={() => void decide(head.id, ALWAYS_ALLOW_FOLDER)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors",
            persistentDisabled
              ? "pointer-events-none opacity-40"
              : "hover:bg-accent/40 hover:text-foreground",
          )}
        >
          Always
        </button>
        <button
          type="button"
          onClick={() => void decide(head.id, ALLOW_ONCE)}
          className="ml-1 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
          title="⌘+Enter"
        >
          Allow once
        </button>
      </div>
    </div>
  );
}
