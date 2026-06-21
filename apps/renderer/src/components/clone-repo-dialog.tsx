import { HugeiconsIcon } from "@hugeicons/react";
import { GlobeIcon, LockIcon } from "@hugeicons-pro/core-bulk-rounded";
import { useEffect, useState } from "react";

import type { GithubRepoSummary } from "@memoize/wire";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useWorkspaceStore } from "../store/workspace.ts";

interface CloneRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Clone GitHub repo" dialog from the screenshot. Three fields — URL,
 * Location (with Browse), and a scrollable Recent repos list. Submitting
 * runs `workspace.cloneRepo` and registers the result. We fetch
 * `gh repo list` lazily on first-open so the dialog doesn't pay for the
 * subprocess until the user actually wants it.
 */
export function CloneRepoDialog({ open, onOpenChange }: CloneRepoDialogProps) {
  const recents = useWorkspaceStore((s) => s.recentGithubRepos);
  const recentsLoading = useWorkspaceStore((s) => s.recentGithubReposLoading);
  const ghAuthenticated = useWorkspaceStore((s) => s.ghAuthenticated);
  const loadGithubContext = useWorkspaceStore((s) => s.loadGithubContext);
  const pickFolder = useWorkspaceStore((s) => s.pickFolder);
  const cloneRepo = useWorkspaceStore((s) => s.cloneRepo);

  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load `gh` data the first time the dialog opens. Subsequent
  // opens reuse the cache; the user can click "Refresh" to re-run.
  useEffect(() => {
    if (!open) return;
    if (recents === null) void loadGithubContext();
  }, [open, recents, loadGithubContext]);

  // Reset transient form state every time the dialog closes so a
  // stale error doesn't reappear on the next open.
  useEffect(() => {
    if (open) return;
    setUrl("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  const onBrowse = async () => {
    const picked = await pickFolder();
    if (picked !== null) setParent(picked);
  };

  const canSubmit = url.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await cloneRepo(url.trim(), parent.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter — matches the "⌘↩" chip on the submit button.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const onPickRecent = (repo: GithubRepoSummary) => {
    // Prefer SSH when gh's `sshUrl` is populated — matches how most
    // developers already authenticate.
    setUrl(repo.sshUrl || repo.httpsUrl);
  };

  // Don't let backdrop / Esc close the dialog mid-clone — a stale
  // background process would land its folder later with no UI.
  const handleOpenChange = (next: boolean) => {
    if (submitting && !next) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Clone GitHub repo</DialogTitle>
          <DialogDescription className="sr-only">
            Clone a repository and add it to your workspace.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-5" onKeyDown={onKeyDown}>
          <Field label="Repository URL">
            <Input
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder="https://github.com/user/repo.git"
              autoFocus
              aria-invalid={error !== null ? true : undefined}
            />
            {error !== null && (
              <p className="text-[11px] text-destructive">{error}</p>
            )}
          </Field>

          <Field label="Recent repos">
            <RecentRepos
              repos={recents}
              loading={recentsLoading}
              authenticated={ghAuthenticated}
              onPick={onPickRecent}
              selectedUrl={url}
            />
          </Field>

          <Field label="Location">
            <div className="flex items-center gap-2">
              <Input
                value={parent}
                onChange={(e) => setParent(e.currentTarget.value)}
                placeholder="~/Developer"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void onBrowse()}
              >
                Browse
              </Button>
            </div>
          </Field>
        </DialogPanel>

        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="ghost" disabled={submitting}>
                Cancel
              </Button>
            }
          />
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="gap-2"
          >
            {submitting ? (
              <>
                <span className="inline-flex size-3.5 items-center justify-center">
                  <Spinner className="size-3.5" />
                </span>
                Cloning…
              </>
            ) : (
              <>
                Clone repo
                <kbd className="font-sans text-[10px] text-muted-foreground/80">
                  ⌘↩
                </kbd>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Field wrapper — label + body, matching the spacing used in the
 * `permissions-inspector` dialog so the visual language stays consistent.
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * Body of the "Recent repos" panel. Renders one of four states:
 *   - loading        → animated placeholder rows
 *   - not signed in  → one-line hint to run `gh auth login`
 *   - empty list     → "no repos found" placeholder
 *   - non-empty list → the rows themselves, with `(owner) repo / desc`
 */
function RecentRepos({
  repos,
  loading,
  authenticated,
  onPick,
  selectedUrl,
}: {
  repos: ReadonlyArray<GithubRepoSummary> | null;
  loading: boolean;
  authenticated: boolean | null;
  onPick: (repo: GithubRepoSummary) => void;
  selectedUrl: string;
}) {
  if (loading || repos === null) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-input bg-background/40 text-[11px] text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (authenticated === false || repos.length === 0) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-background/40 px-4 text-center text-[11px] text-muted-foreground">
        <HugeiconsIcon icon={GlobeIcon} className="size-4 opacity-60" />
        <p>
          {authenticated === false
            ? "Sign in with `gh auth login` to see your repos."
            : "No GitHub repos found."}
        </p>
      </div>
    );
  }
  return (
    <ul className="max-h-56 overflow-y-auto rounded-lg border border-input bg-background/40">
      {repos.map((repo) => {
        const active =
          repo.sshUrl === selectedUrl || repo.httpsUrl === selectedUrl;
        return (
          <li key={repo.nameWithOwner}>
            <button
              type="button"
              onClick={() => onPick(repo)}
              className={
                "flex w-full flex-col items-start gap-0.5 border-b border-input/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-sidebar-accent/40 " +
                (active ? "bg-sidebar-accent/40" : "")
              }
            >
              <span className="flex items-center gap-1.5 text-[12px] text-foreground">
                {repo.nameWithOwner}
                {repo.isPrivate && (
                  <HugeiconsIcon
                    icon={LockIcon}
                    className="size-2.5 text-muted-foreground"
                  />
                )}
              </span>
              {repo.description !== null && (
                <span className="line-clamp-1 text-[11px] text-muted-foreground">
                  {repo.description}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
