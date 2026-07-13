import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Brain01Icon,
  BrowserIcon,
  BubbleChatIcon,
  Camera01Icon,
  CheckListIcon,
  Copy01Icon,
  File01Icon,
  Folder01Icon,
  GlobeIcon,
  PencilEdit01Icon,
  Robot01Icon,
  SearchIcon,
  TerminalIcon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import {
  isRedundantShellDescription,
  type ChatId,
  type SessionId,
  type UserQuestion,
  type UserQuestionAnswer,
} from "@zuse/contracts";

import { parseOrchestrationResult } from "~/lib/orchestration-tools";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import { useSessionsStore } from "~/store/sessions";

import { Button } from "./ui/button.tsx";
import { CodeBlock } from "./code-block.tsx";
import { resolveFileOpenTarget, useFileChipContext } from "./file-chip.tsx";
import { FileIcon } from "./file-icon.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import {
  diffStats,
  EditDiff,
  extractEdits,
  extractPatchEntries,
  type FileEdit,
  patchStats,
  UnifiedPatchDiff,
} from "./inline-diff.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";
import { useUiStore, type FileView } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";
import { useWorktreesStore } from "~/store/worktrees";

type IconHandle = Parameters<typeof HugeiconsIcon>[0]["icon"];

const normalizeToolName = (tool: string): string =>
  tool.replace(/^mcp__memoize__/, "mcp__zuse__");

/**
 * Map a tool name to the same Hugeicon used in its expanded ToolRow. Other
 * surfaces (e.g. the turn-summary icon preview) reuse this so the icons
 * stay in lockstep across the timeline.
 */
export const iconForTool = (tool: string): IconHandle => {
  const normalizedTool = normalizeToolName(tool);
  switch (normalizedTool) {
    case "Bash":
      return TerminalIcon;
    case "Read":
    case "ReadFile":
      return File01Icon;
    case "Edit":
    case "Write":
    case "WriteFile":
    case "MultiEdit":
      return PencilEdit01Icon;
    case "Grep":
    case "Glob":
    case "Search":
      return SearchIcon;
    case "ListDir":
    case "ListDirectory":
      return Folder01Icon;
    case "Task":
    case "Agent":
    case "SpawnAgent":
    case "CollabSpawnAgent":
    case "CollabSendInput":
    case "CollabResumeAgent":
    case "CollabCloseAgent":
    case "CollabWait":
      return Robot01Icon;
    case "WebFetch":
    case "WebSearch":
      return GlobeIcon;
    case "TodoWrite":
      return CheckListIcon;
    case "mcp__zuse__browser_navigate":
      return BrowserIcon;
    case "mcp__zuse__browser_screenshot":
      return Camera01Icon;
    default: {
      // Agent browser tools arrive as their MCP FQN; match by suffix so the
      // exact-case list above stays the source of truth.
      if (normalizedTool.endsWith("__browser_screenshot")) return Camera01Icon;
      if (normalizedTool.includes("__browser_")) return BrowserIcon;
      // Heuristic fallback for any Grok-native or future tool we haven't
      // wired an exact case for yet. "list dir", "read file", "run shell"
      // etc. will now get a reasonable icon instead of the generic wrench.
      const t = normalizedTool.toLowerCase();
      if (t.includes("dir") || t.includes("folder") || t.includes("list"))
        return Folder01Icon;
      if (t.includes("file") || t.includes("read") || t.includes("write"))
        return File01Icon;
      if (
        t.includes("bash") ||
        t.includes("shell") ||
        t.includes("cmd") ||
        t.includes("exec")
      )
        return TerminalIcon;
      if (t.includes("search") || t.includes("grep") || t.includes("glob"))
        return SearchIcon;
      if (t.includes("web") || t.includes("http")) return GlobeIcon;
      return Wrench01Icon;
    }
  }
};

interface ToolResult {
  readonly output: unknown;
  readonly isError: boolean;
}

const stringifyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

const dirname = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i + 1);
};

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max - 1) + "…" : s;

/**
 * Coerce a tool_result `output` into displayable text. The Anthropic SDK
 * sometimes returns a string, sometimes an array of content blocks (each
 * with its own `text`); fall back to JSON for anything stranger.
 */
const toResultText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      // Direct {type: "text", text: "..."}
      if (typeof b.text === "string") {
        parts.push(b.text);
        continue;
      }
      // MCP-wrapped {type: "content", content: {type: "text", text: "..."}}
      const inner = b.content;
      if (inner !== null && typeof inner === "object") {
        const it = (inner as Record<string, unknown>).text;
        if (typeof it === "string") parts.push(it);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    const inner = o.content;
    if (typeof inner === "string") return inner;
    if (Array.isArray(inner)) return toResultText(inner);
  }
  return stringifyJson(output);
};

// First-sentence (or first-line) teaser, with whitespace collapsed and
// hard-capped so a single fat row doesn't blow up the timeline.
const firstSentence = (text: string, hardCap = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const periodIdx = flat.indexOf(". ");
  const newlineIdx = flat.indexOf("\n");
  const stops = [periodIdx, newlineIdx].filter((i) => i > 0);
  const cut = stops.length > 0 ? Math.min(...stops) + 1 : flat.length;
  return truncate(flat.slice(0, cut).trim(), hardCap);
};

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------

function InlineTextHint({ value }: { value: string }) {
  return (
    <span
      className="inline-block max-w-full truncate align-bottom text-muted-foreground italic"
      title={value}
    >
      {value}
    </span>
  );
}

/** Soft +/− line counts for edit rows — muted but still readable as color. */
function SoftDiffStats({
  added,
  removed,
}: {
  added: number;
  removed: number;
}) {
  if (added <= 0 && removed <= 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
      {added > 0 ? (
        <span className="text-[oklch(0.75_0.12_155)]">+{added}</span>
      ) : null}
      {removed > 0 ? (
        <span className="text-[oklch(0.72_0.12_25)]">−{removed}</span>
      ) : null}
    </span>
  );
}

/**
 * Chipless file reference for collapsed tool rows — file-type icon + muted
 * mono name (+ optional count), click-to-open. Replaces the old FileBadge
 * pill so the live feed stays quiet.
 */
function MutedFilePath({
  path,
  view,
  suffix,
}: {
  path: string;
  view?: FileView;
  suffix?: React.ReactNode;
}) {
  const name = basename(path);
  const { folderId, worktreeId } = useFileChipContext();
  const openFileInTab = useUiStore((s) => s.openFileInTab);
  const folderPath = useWorkspaceStore((s) => {
    if (folderId === null) return null;
    return s.folders.find((f) => f.id === folderId)?.path ?? null;
  });
  const worktreePath = useWorktreesStore((s) => {
    if (folderId === null || worktreeId === null) return null;
    const list = s.byProject[folderId] ?? [];
    return list.find((w) => w.id === worktreeId)?.path ?? null;
  });
  const openTarget = resolveFileOpenTarget({
    relPath: path,
    absPath: path,
    kind: "file",
    folderId,
    worktreeId,
    folderPath,
    worktreePath,
    view,
  });
  const canOpen = openTarget !== null;

  const onClick = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (openTarget === null) return;
    e.preventDefault();
    e.stopPropagation();
    openFileInTab(openTarget);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!canOpen) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      openFileInTab(openTarget!);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role={canOpen ? "button" : undefined}
            tabIndex={canOpen ? 0 : undefined}
            onClick={canOpen ? onClick : undefined}
            onKeyDown={canOpen ? onKeyDown : undefined}
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] text-muted-foreground",
              canOpen
                ? "cursor-pointer hover:text-foreground/80"
                : "cursor-default",
            )}
            title={path}
          >
            <FileIcon
              name={name}
              kind="file"
              className="inline-flex size-3.5 shrink-0 items-center justify-center opacity-80"
            />
            <span className="min-w-0 truncate font-mono">{name}</span>
            {suffix !== undefined && suffix !== null && suffix !== "" ? (
              <span className="inline-flex shrink-0 items-center gap-1 opacity-90">
                {typeof suffix === "string" || typeof suffix === "number" ? (
                  <span className="tabular-nums opacity-80">({suffix})</span>
                ) : (
                  suffix
                )}
              </span>
            ) : null}
          </span>
        }
      />
      <TooltipPopup>{canOpen ? `Open ${path}` : path}</TooltipPopup>
    </Tooltip>
  );
}

function TerminalBlock({
  command,
  output,
  isError,
}: {
  command?: string;
  output?: string;
  isError?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded border px-3 py-2 font-mono text-[11px] leading-relaxed",
        isError
          ? "border-alert-error-bg bg-alert-error-bg"
          : "border-message-rule bg-message-pre-bg",
      )}
    >
      {command !== undefined ? (
        <div className="whitespace-pre-wrap break-words text-foreground/90">
          <span className="select-none text-muted-foreground">$ </span>
          {command}
        </div>
      ) : null}
      {output !== undefined && output.length > 0 ? (
        <div
          className={cn(
            "whitespace-pre-wrap break-words",
            command !== undefined ? "mt-2" : "",
            "text-foreground/80",
          )}
        >
          {output}
        </div>
      ) : null}
    </div>
  );
}

function ErrorPill() {
  return (
    <span className="mr-2 rounded bg-destructive/12 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
      Error
    </span>
  );
}

function FileListBlock({ paths }: { paths: ReadonlyArray<string> }) {
  if (paths.length === 0) {
    return (
      <p className="text-[11px] italic text-muted-foreground">No matches.</p>
    );
  }
  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {paths.map((p, i) => {
        const dir = dirname(p);
        const base = basename(p);
        return (
          <li key={i} className="truncate">
            <span className="text-muted-foreground">{dir}</span>
            <span className="text-foreground/90">{base}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Render a `list_dir` tree (the indented "- name" / "  - sub/" text Grok's
 * tool emits) as a calm monospace block — directories muted, files bright —
 * instead of a raw JSON dump. Indentation is preserved verbatim.
 */
function DirTreeBlock({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const hasContent = lines.some((l) => l.trim().length > 0);
  if (!hasContent) {
    return (
      <p className="text-[11px] italic text-muted-foreground">
        Empty directory.
      </p>
    );
  }
  return (
    <pre className="overflow-x-auto rounded border border-message-rule bg-message-pre-bg px-3 py-2 font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => {
        const isDir = line.trimEnd().endsWith("/");
        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre",
              isDir ? "text-muted-foreground" : "text-foreground/90",
            )}
          >
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Render grep matches grouped by file: a muted file path header followed
 * by the matched lines. Far nicer than the raw `{ stdout: [char codes],
 * file_matches: [...] }` envelope Grok returns.
 */
function GrepGroupsBlock({
  groups,
}: {
  groups: ReadonlyArray<{ path: string; matches: ReadonlyArray<string> }>;
}) {
  return (
    <div className="space-y-2">
      {groups.map((g, i) => (
        <div key={i} className="space-y-0.5">
          <MutedFilePath path={g.path} />
          {g.matches.length > 0 ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-message-rule bg-message-pre-bg px-3 py-1.5 font-mono text-[11px] text-foreground/80">
              {g.matches.join("\n")}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MarkdownBlock({ text }: { text: string }) {
  return <MarkdownBody className="text-[12px]">{text}</MarkdownBody>;
}

function PreBlock({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap break-words rounded border px-3 py-2 font-mono text-[11px] text-foreground/80",
        isError
          ? "border-alert-error-bg bg-alert-error-bg"
          : "border-message-rule bg-message-pre-bg",
      )}
    >
      {text || "(empty)"}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Result extractors (per tool)
// ---------------------------------------------------------------------------

const splitLines = (s: string): ReadonlyArray<string> => {
  const trimmed = s.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((l) => l.length > 0);
};

// Grep / Glob results are usually one path per line, sometimes followed
// by a header like "Found N files". Filter out obvious headers.
const parseFileList = (output: string): ReadonlyArray<string> => {
  const lines = splitLines(output);
  return lines.filter((l) => !/^found\s+\d+\s+/i.test(l) && !/^no\s+/i.test(l));
};

interface GrepGroup {
  readonly path: string;
  readonly matches: ReadonlyArray<string>;
}

/**
 * Parse grep output into per-file groups. A flush-left line is a file path;
 * indented lines are matches under the current file. Plain path-per-line
 * output (files-with-matches mode) yields groups with no matches, which the
 * caller renders as a simple file list. Summary lines ("Found N files", "No
 * matches") are dropped.
 */
const parseGrepGroups = (output: string): ReadonlyArray<GrepGroup> => {
  const groups: Array<{ path: string; matches: string[] }> = [];
  let current: { path: string; matches: string[] } | null = null;
  for (const raw of output.split("\n")) {
    if (raw.trim().length === 0) continue;
    if (/^\s/.test(raw) && current !== null) {
      current.matches.push(raw.trim());
      continue;
    }
    const line = raw.trim();
    if (/^found\s+\d+\s+/i.test(line) || /^no\s+/i.test(line)) continue;
    current = { path: line, matches: [] };
    groups.push(current);
  }
  return groups;
};

// Count the leaf files in a `list_dir` tree (lines that aren't directories).
const countTreeFiles = (tree: string): number =>
  splitLines(tree).filter((l) => !l.endsWith("/")).length;

// ---------------------------------------------------------------------------
// Expandable row primitive (icon ↔ chevron hover swap, click to toggle)
// ---------------------------------------------------------------------------

function ExpandableIconRow({
  icon,
  label,
  detail,
  body,
  hasContent,
  pending = false,
}: {
  icon: IconHandle;
  label: string;
  detail?: React.ReactNode;
  body: React.ReactNode;
  hasContent: boolean;
  /** True while the tool/thinking is still running — label shimmers. */
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
  return (
    <div className="px-4 py-0.5">
      <button
        type="button"
        onClick={() => hasContent && setExpanded((e) => !e)}
        className={cn(
          "group flex w-full max-w-2xl items-center gap-2 rounded px-1.5 py-1 text-left text-xs",
          hasContent ? "cursor-pointer" : "cursor-default",
        )}
      >
        <div className="relative grid size-4 shrink-0 place-items-center">
          <HugeiconsIcon
            icon={icon}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "col-start-1 row-start-1 size-3.5 text-muted-foreground transition-opacity duration-150 ease-out",
              hasContent ? "group-hover:opacity-0" : "",
              "motion-reduce:transition-none",
            )}
          />
          {hasContent ? (
            <HugeiconsIcon
              icon={chevron}
              aria-hidden="true"
              className={cn(
                "col-start-1 row-start-1 size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out",
                "group-hover:opacity-100 motion-reduce:transition-none",
              )}
            />
          ) : null}
        </div>
        <span
          className="max-w-[16rem] shrink-0 truncate text-muted-foreground"
          title={label}
        >
          {pending ? (
            <ShimmerText tone="lime" className="text-muted-foreground">
              {label}
            </ShimmerText>
          ) : (
            label
          )}
        </span>
        {detail !== undefined ? (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap [&>*]:min-w-0 [&>*]:max-w-full [&>*]:overflow-hidden [&>*]:text-ellipsis">
            {detail}
          </span>
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="ml-6 mt-1 max-h-96 max-w-2xl space-y-2 overflow-y-auto border-l border-border/60 pl-2 pr-1">
          {body}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tool views
// ---------------------------------------------------------------------------

interface ToolView {
  readonly icon: IconHandle;
  readonly label: string;
  readonly detail?: React.ReactNode;
  readonly inputPanel?: React.ReactNode;
  readonly resultPanel?: (result: ToolResult) => React.ReactNode;
  readonly fallbackBody?: React.ReactNode;
}

// Line-count derived from a tool result's textual output. Used by Read /
// Grep / Glob to summarise "how much did this return?" in the collapsed row.
const lineCountOf = (output: unknown): number => {
  const text = toResultText(output);
  if (text.length === 0) return 0;
  return text.split("\n").length;
};

const buildToolView = (
  tool: string,
  input: unknown,
  result: ToolResult | undefined,
): ToolView => {
  const normalizedTool = normalizeToolName(tool);
  const obj =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  switch (normalizedTool) {
    case "Bash":
    case "Shell":
    case "shell":
    case "Execute":
    case "execute":
    case "Run":
    case "run":
    case "run_shell_command":
    case "run_terminal_cmd":
    case "run_terminal_command":
    case "Run Terminal Command": {
      const cmd =
        asString(obj.command) ??
        asString(obj.cmd) ??
        asString(obj.shell_command) ??
        asString(input);
      const desc = asString(obj.description);
      const fallbackLabel =
        normalizedTool === "Bash"
          ? "Bash"
          : normalizedTool === "Shell"
            ? "Shell"
            : "Execute";
      // Keep a genuine human summary as the label; fall back to the tool
      // name when description is missing or just echoes the command (also
      // covers old persisted Codex/ACP sessions that stored the echo).
      const label =
        desc !== null &&
        (cmd === null || !isRedundantShellDescription(desc, cmd))
          ? desc
          : fallbackLabel;
      // Command lives under the chevron — collapsed row is just the label.
      return {
        icon: TerminalIcon,
        label,
        fallbackBody:
          cmd === null ? (
            <PreBlock text={stringifyJson(input)} />
          ) : (
            <TerminalBlock
              command={cmd}
              output={
                result === undefined
                  ? undefined
                  : toResultText(result.output) || "(no output)"
              }
              isError={result?.isError}
            />
          ),
      };
    }

    case "Read": {
      const path = asString(obj.file_path);
      const offset = typeof obj.offset === "number" ? obj.offset : null;
      const limit = typeof obj.limit === "number" ? obj.limit : null;
      const range =
        offset !== null || limit !== null
          ? `lines ${offset ?? 1}–${(offset ?? 1) + (limit ?? 0) - 1}`
          : null;
      const pending = result === undefined;
      const lines = result !== undefined ? lineCountOf(result.output) : null;
      const linesSuffix =
        lines !== null
          ? lines === 0
            ? "empty"
            : `${lines} line${lines === 1 ? "" : "s"}`
          : null;
      return {
        icon: File01Icon,
        label: pending ? "Reading" : "Read",
        detail:
          path !== null ? (
            <MutedFilePath path={path} suffix={linesSuffix} />
          ) : undefined,
        inputPanel:
          path !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground break-all">
              {path}
              {range !== null ? ` · ${range}` : null}
            </p>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (path === null) {
            return (
              <PreBlock text={truncate(text, 4000)} isError={result.isError} />
            );
          }
          return (
            <CodeBlock filename={path} text={text} isError={result.isError} />
          );
        },
      };
    }

    case "Edit":
    case "Write":
    case "MultiEdit": {
      const path = asString(obj.file_path);
      const patches = extractPatchEntries(input);
      const edits = patches.length > 0 ? [] : extractEdits(tool, input);
      const fileCount =
        patches.length || new Set(edits.map((e) => e.path)).size;
      const pending = result === undefined;
      const label =
        tool === "Write"
          ? pending
            ? "Writing"
            : "Wrote"
          : pending
            ? "Editing"
            : "Edited";
      const stats =
        patches.length > 0
          ? patchStats(patches)
          : edits.length > 0
            ? diffStats(edits)
            : null;
      const editCount = patches.length > 0 ? patches.length : edits.length;
      const statsNode =
        stats !== null && (stats.added > 0 || stats.removed > 0) ? (
          <SoftDiffStats added={stats.added} removed={stats.removed} />
        ) : editCount > 0 ? (
          <span className="tabular-nums text-muted-foreground/80">
            {editCount} edit{editCount === 1 ? "" : "s"}
          </span>
        ) : null;
      return {
        icon: PencilEdit01Icon,
        label:
          tool === "MultiEdit" && fileCount > 1
            ? `${label} ${fileCount} files`
            : label,
        detail:
          path !== null ? (
            <MutedFilePath path={path} view="diff" suffix={statsNode} />
          ) : path === null && statsNode !== null && tool === "MultiEdit" ? (
            statsNode
          ) : undefined,
        fallbackBody:
          patches.length > 0 ? (
            <div className="space-y-2">
              {patches.map((patch, i) => (
                <UnifiedPatchDiff
                  key={i}
                  path={patch.file_path}
                  patch={patch.patch}
                  kind={patch.kind}
                  showHeader={patches.length > 1}
                />
              ))}
            </div>
          ) : edits.length > 0 ? (
            <div className="space-y-px">
              {edits.map((edit, i) => (
                <EditDiff
                  key={i}
                  edit={edit as FileEdit}
                  showHeader={edits.length > 1}
                />
              ))}
            </div>
          ) : (
            <PreBlock text={stringifyJson(input)} />
          ),
        resultPanel: (result) =>
          result.isError ? (
            <PreBlock text={toResultText(result.output)} isError />
          ) : null,
      };
    }

    case "Grep": {
      const pattern = asString(obj.pattern);
      const path = asString(obj.path);
      const glob = asString(obj.glob);
      const type = asString(obj.type);
      const where = path ?? glob ?? type;
      const files =
        result !== undefined && !result.isError
          ? parseGrepGroups(toResultText(result.output)).length
          : null;
      const matchesHint =
        files !== null ? (files === 0 ? "no matches" : `${files}`) : null;
      return {
        icon: SearchIcon,
        label: "Grep",
        // Pattern/scope live under the chevron; count sits next to the label.
        detail:
          matchesHint !== null ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {matchesHint}
            </span>
          ) : undefined,
        inputPanel:
          pattern !== null ? (
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <div>
                pattern{" "}
                <span className="font-mono text-foreground/90">{pattern}</span>
              </div>
              {where !== null ? (
                <div>
                  scope{" "}
                  <span className="font-mono text-foreground/90">{where}</span>
                </div>
              ) : null}
            </div>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (result.isError) return <PreBlock text={text} isError />;
          const groups = parseGrepGroups(text);
          if (groups.length === 0) {
            return <PreBlock text={text || "No matches."} />;
          }
          return groups.some((g) => g.matches.length > 0) ? (
            <GrepGroupsBlock groups={groups} />
          ) : (
            <FileListBlock paths={groups.map((g) => g.path)} />
          );
        },
      };
    }

    case "Glob": {
      const pattern = asString(obj.pattern);
      const matches =
        result !== undefined && !result.isError
          ? parseFileList(toResultText(result.output)).length
          : null;
      const matchesHint =
        matches !== null ? (matches === 0 ? "no matches" : `${matches}`) : null;
      return {
        icon: SearchIcon,
        label: "Glob",
        detail:
          matchesHint !== null ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {matchesHint}
            </span>
          ) : undefined,
        inputPanel:
          pattern !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {pattern}
            </p>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (result.isError) return <PreBlock text={text} isError />;
          const paths = parseFileList(text);
          return paths.length > 0 ? (
            <FileListBlock paths={paths} />
          ) : (
            <PreBlock text={text || "No matches."} />
          );
        },
      };
    }

    case "ListDir":
    case "ListDirectory": {
      const path =
        asString(obj.path) ??
        asString(obj.dir_path) ??
        asString(obj.directory) ??
        asString(obj.relative_workspace_path);
      const files =
        result !== undefined && !result.isError
          ? countTreeFiles(toResultText(result.output))
          : null;
      const filesHint =
        files !== null ? (files === 0 ? "empty" : `${files}`) : null;
      return {
        icon: Folder01Icon,
        label: "List",
        detail:
          filesHint !== null ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {filesHint}
            </span>
          ) : undefined,
        inputPanel:
          path !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground break-all">
              {path}
            </p>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (result.isError) return <PreBlock text={text} isError />;
          return <DirTreeBlock text={text} />;
        },
      };
    }

    case "Task":
    case "Agent": {
      const desc = asString(obj.description) ?? asString(obj.subagent_type);
      const prompt = asString(obj.prompt);
      return {
        icon: Robot01Icon,
        label: "Agent",
        inputPanel:
          desc !== null || prompt !== null ? (
            <div className="space-y-1">
              {desc !== null ? (
                <p className="text-[11px] text-muted-foreground italic">
                  {desc}
                </p>
              ) : null}
              {prompt !== null ? (
                <>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Prompt
                  </p>
                  <PreBlock text={prompt} />
                </>
              ) : null}
            </div>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (result.isError) return <PreBlock text={text} isError />;
          return (
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Reply
              </p>
              <MarkdownBlock text={text || "(empty)"} />
            </div>
          );
        },
      };
    }

    case "WebFetch": {
      const url = asString(obj.url);
      return {
        icon: GlobeIcon,
        label: "WebFetch",
        inputPanel:
          url !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground break-all">
              {url}
            </p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={truncate(toResultText(result.output), 4000)}
            isError={result.isError}
          />
        ),
      };
    }

    case "WebSearch": {
      const q = asString(obj.query);
      return {
        icon: GlobeIcon,
        label: "WebSearch",
        inputPanel:
          q !== null ? (
            <p className="text-[11px] text-muted-foreground">{q}</p>
          ) : undefined,
        resultPanel: (result) => {
          const text = toResultText(result.output);
          if (text.trim().length === 0 && !result.isError) {
            return (
              <p className="px-1 text-[11px] text-muted-foreground italic">
                (no results returned)
              </p>
            );
          }
          return (
            <PreBlock text={truncate(text, 4000)} isError={result.isError} />
          );
        },
      };
    }

    case "TodoWrite": {
      const todos = Array.isArray(obj.todos) ? obj.todos : null;
      return {
        icon: CheckListIcon,
        label: "TodoWrite",
        detail:
          todos !== null ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {todos.length}
            </span>
          ) : undefined,
        fallbackBody:
          todos !== null ? (
            <ul className="space-y-0.5 text-[11px]">
              {todos.map((t, i) => {
                if (t === null || typeof t !== "object")
                  return <li key={i}>{stringifyJson(t)}</li>;
                const r = t as Record<string, unknown>;
                const content =
                  asString(r.content) ?? asString(r.activeForm) ?? "";
                const status = asString(r.status) ?? "";
                return (
                  <li key={i} className="font-mono">
                    <span className="text-muted-foreground">[{status}]</span>{" "}
                    {content}
                  </li>
                );
              })}
            </ul>
          ) : (
            <PreBlock text={stringifyJson(input)} />
          ),
      };
    }

    case "SpawnAgent":
    case "CollabSpawnAgent": {
      const receivers = Array.isArray(obj.receiverThreadIds)
        ? (obj.receiverThreadIds as string[])
        : [];
      const promptText = asString(obj.prompt) ?? "";
      const model = asString(obj.model);
      const states = (obj.agentsStates ?? {}) as Record<string, unknown>;
      const n = receivers.length || Object.keys(states).length || 1;

      return {
        icon: Robot01Icon,
        label: `Spawn ${n} agent${n === 1 ? "" : "s"}`,
        fallbackBody: (
          <div className="space-y-1.5 text-[12px]">
            {model && (
              <div className="text-muted-foreground">
                Model: <span className="font-mono">{model}</span>
              </div>
            )}
            {promptText && (
              <div className="rounded border bg-muted p-1.5 font-mono text-[11px] leading-snug">
                {promptText.length > 280
                  ? promptText.slice(0, 277) + "…"
                  : promptText}
              </div>
            )}
            {receivers.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                Threads: {receivers.slice(0, 4).join(", ")}
                {receivers.length > 4 ? ` +${receivers.length - 4}` : ""}
              </div>
            )}
            {Object.keys(states).length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                Live states: {Object.keys(states).length} tracked
              </div>
            )}
          </div>
        ),
        resultPanel: (result) => (
          <PreBlock
            text={
              toResultText(result.output) || stringifyJson(obj.agentsStates)
            }
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_navigate": {
      const targetUrl = asString(obj.url);
      return {
        icon: BrowserIcon,
        label: "Browse",
        inputPanel:
          targetUrl !== null ? (
            <p className="text-[11px] text-muted-foreground break-all">
              {targetUrl}
            </p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output) || "(loaded)"}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_screenshot": {
      return {
        icon: Camera01Icon,
        label: "Screenshot",
        resultPanel: (result) =>
          result.isError ? (
            <PreBlock text={toResultText(result.output)} isError />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Captured the visible page.
            </span>
          ),
      };
    }

    case "mcp__zuse__browser_snapshot": {
      return {
        icon: BrowserIcon,
        label: "Read page",
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_click": {
      const ref = asString(obj.ref);
      return {
        icon: BrowserIcon,
        label: "Click",
        inputPanel:
          ref !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground">{ref}</p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_type": {
      const typed = asString(obj.text);
      return {
        icon: BrowserIcon,
        label: "Type",
        inputPanel:
          typed !== null ? (
            <p className="text-[11px] text-muted-foreground">{typed}</p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_wait": {
      const sel = asString(obj.selector);
      const ms = typeof obj.ms === "number" ? `${obj.ms}ms` : null;
      const hint = sel ?? ms ?? "settle";
      return {
        icon: BrowserIcon,
        label: "Wait",
        inputPanel: <p className="text-[11px] text-muted-foreground">{hint}</p>,
      };
    }

    case "mcp__zuse__browser_scroll": {
      const dir = asString(obj.direction);
      const ref = asString(obj.ref);
      const hint = ref ?? dir ?? "down";
      return {
        icon: BrowserIcon,
        label: "Scroll",
        inputPanel: <p className="text-[11px] text-muted-foreground">{hint}</p>,
      };
    }

    case "mcp__zuse__browser_hover": {
      const ref = asString(obj.ref);
      return {
        icon: BrowserIcon,
        label: "Hover",
        inputPanel:
          ref !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground">{ref}</p>
          ) : undefined,
      };
    }

    case "mcp__zuse__browser_select": {
      const value = asString(obj.value);
      return {
        icon: BrowserIcon,
        label: "Select",
        inputPanel:
          value !== null ? (
            <p className="text-[11px] text-muted-foreground">{value}</p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_press": {
      const key = asString(obj.key);
      return {
        icon: BrowserIcon,
        label: "Press",
        inputPanel:
          key !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground">{key}</p>
          ) : undefined,
      };
    }

    case "mcp__zuse__browser_read": {
      return {
        icon: File01Icon,
        label: "Read page",
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_history": {
      const action = asString(obj.action);
      return {
        icon: BrowserIcon,
        label:
          action === "back"
            ? "Back"
            : action === "forward"
              ? "Forward"
              : "Reload",
      };
    }

    case "mcp__zuse__browser_console": {
      return {
        icon: TerminalIcon,
        label: "Console",
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    case "mcp__zuse__browser_login": {
      const origin = asString(obj.origin);
      return {
        icon: BrowserIcon,
        label: "Log in",
        inputPanel:
          origin !== null ? (
            <p className="text-[11px] text-muted-foreground break-all">
              {origin}
            </p>
          ) : undefined,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }

    default: {
      // Produce a human-friendly label even for completely unknown tools
      // (Grok's future native tools, custom MCP tools, etc.). We title-case
      // and replace underscores so "list_dir" or "run_terminal_cmd" look
      // reasonable instead of the raw token the user was seeing.
      const niceLabel = tool
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_\-.]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
      return {
        icon: iconForTool(tool), // will pick a heuristic icon
        label: niceLabel || "Tool",
        fallbackBody: <PreBlock text={stringifyJson(input)} />,
        resultPanel: (result) => (
          <PreBlock
            text={toResultText(result.output)}
            isError={result.isError}
          />
        ),
      };
    }
  }
};

/**
 * Plan card for the SDK's `ExitPlanMode` tool. The card itself owns
 * approval — finds the matching pending `permission.request` for this
 * session and resolves it on click. Approving lets the SDK run
 * ExitPlanMode, which auto-flips out of plan mode; rejecting keeps the
 * agent in plan mode to iterate.
 *
 * Visual states (kept minimal — no flashy fills, just a subtle border):
 *   - **Pending** — result undefined; show Approve / Reject.
 *   - **Approved** — result with `isError: false`; small "Approved" tag.
 *   - **Rejected** — result with `isError: true`; small "Rejected" tag.
 */
export function ExitPlanModeRow({
  input,
  result,
}: {
  input: unknown;
  result?: ToolResult;
}) {
  const plan =
    typeof input === "object" && input !== null && "plan" in input
      ? typeof (input as { plan?: unknown }).plan === "string"
        ? ((input as { plan: string }).plan as string)
        : null
      : null;

  const status: "pending" | "approved" | "cancelled" =
    result === undefined
      ? "pending"
      : result.isError
        ? "cancelled"
        : "approved";

  // Pending plans render the full body inline; the Approve / Cancel decision
  // lives in the pinned `PlanApprovalTray` above the composer, where the user's
  // cursor already sits — see composer/plan-approval-tray.tsx. Resolved plans
  // (approved / rejected) collapse into the same icon-row accordion the rest of
  // the timeline uses, with the plan body behind the chevron and the status pill
  // pinned to the body footer.
  if (status === "pending") {
    return (
      <div className="px-4 py-2">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <HugeiconsIcon icon={CheckListIcon} size={14} strokeWidth={2} />
          <span>Plan</span>
        </div>
        {plan === null ? (
          <p className="text-sm italic text-muted-foreground">
            (No plan body.)
          </p>
        ) : (
          <MarkdownBody>{plan}</MarkdownBody>
        )}
      </div>
    );
  }

  const teaser = plan === null ? "(No plan body.)" : firstSentence(plan);
  const body = (
    <>
      {plan === null ? (
        <p className="text-sm italic text-muted-foreground">(No plan body.)</p>
      ) : (
        <MarkdownBody>{plan}</MarkdownBody>
      )}
      <div className="mt-3 flex items-center justify-end text-[11px] text-muted-foreground">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            status === "approved"
              ? "text-emerald-500/90"
              : "text-muted-foreground",
          )}
        >
          {status === "approved" ? "Approved" : "Cancelled"}
        </span>
      </div>
    </>
  );

  return (
    <ExpandableIconRow
      icon={CheckListIcon}
      label="Plan"
      detail={<InlineTextHint value={teaser} />}
      hasContent
      body={body}
    />
  );
}

export function OrchestrationThreadRow({
  variant,
  result,
}: {
  variant:
    | "create_thread"
    | "create_chat"
    | "create_session"
    | "send_to_thread";
  result?: ToolResult;
}) {
  const parsed =
    result !== undefined ? parseOrchestrationResult(result.output) : null;
  const chatId = parsed?.chatId;
  const sessionId = parsed?.sessionId;
  const chatLoaded = useChatsStore((s) =>
    chatId !== undefined
      ? Object.values(s.chatsByProject).some((list) =>
          list.some((c) => c.id === chatId),
        )
      : false,
  );

  if (result === undefined) {
    return (
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={BubbleChatIcon} size={14} strokeWidth={2} />
          <span>
            {variant === "send_to_thread"
              ? "Sending to thread..."
              : variant === "create_session"
                ? "Creating session tab..."
                : "Creating chat..."}
          </span>
        </div>
      </div>
    );
  }

  const label =
    variant === "send_to_thread"
      ? "Message sent to thread"
      : variant === "create_session"
        ? "Session tab created"
        : "Chat created";
  const openChat = () => {
    if (chatId !== undefined && chatLoaded) {
      useChatsStore.getState().select(chatId as ChatId);
    }
    if (sessionId !== undefined) {
      useSessionsStore.getState().select(sessionId as SessionId);
    }
  };

  return (
    <div className="px-4 py-2">
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <HugeiconsIcon icon={BubbleChatIcon} size={14} strokeWidth={2} />
              <span>{label}</span>
            </div>
            {variant !== "send_to_thread" ? (
              <>
                {typeof parsed?.title === "string" &&
                parsed.title.length > 0 ? (
                  <div className="mt-1 truncate text-sm text-foreground">
                    {parsed.title}
                  </div>
                ) : null}
                {variant === "create_thread" &&
                typeof parsed?.branch === "string" &&
                parsed.branch.length > 0 ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {parsed.branch}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!chatLoaded}
            title={chatLoaded ? "Open chat" : "Chat not loaded yet"}
            onClick={openChat}
          >
            Open chat
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Timeline card for an answered `AskUserQuestion`. While the question is
 * still pending, the composer slot owns the interaction (see
 * `ChatComposer`); once the user submits, this card lands inline in
 * scrollback. Mirrors the `ExitPlanModeRow` card layout — header icon +
 * label + copy button, body, then a footer with meta on the left and the
 * status pill on the right.
 */
export function UserInputRow({
  questions,
  answers,
}: {
  readonly questions: ReadonlyArray<UserQuestion>;
  readonly answers: ReadonlyArray<UserQuestionAnswer>;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = questions
      .map((q, i) => {
        const summary = answerSummaryText(q, answers, i);
        return `Q: ${q.question}\nA: ${summary ?? "(cancelled)"}`;
      })
      .join("\n\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  // Collapsed teaser: first question + its answer (or "cancelled"), flattened
  // and truncated like ThinkingRow / ToolRow detail hints so the row reads
  // as one calm line in scrollback.
  const firstQ = questions[0];
  const teaser = (() => {
    if (firstQ === undefined) return "";
    const ans = answerSummaryText(firstQ, answers, 0) ?? "(cancelled)";
    return firstSentence(`${firstQ.question} · ${ans}`);
  })();

  const body = (
    <>
      <div className="space-y-3">
        {questions.map((q, i) => {
          const summary = answerSummary(q, answers, i);
          return (
            <div key={i} className="text-sm">
              <div className="border-l-2 border-border/60 pl-3 text-foreground/70">
                {q.question}
              </div>
              <div className="mt-1 pl-3 text-foreground">
                {summary === null ? (
                  <span className="italic text-muted-foreground">
                    (cancelled)
                  </span>
                ) : (
                  summary
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>
            {questions.length}{" "}
            {questions.length === 1 ? "question" : "questions"}
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy Q&A"}
            title={copied ? "Copied" : "Copy"}
            className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
          >
            <HugeiconsIcon
              icon={copied ? Tick02Icon : Copy01Icon}
              size={12}
              strokeWidth={2}
            />
          </button>
        </div>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-500/90">
          Answered
        </span>
      </div>
    </>
  );

  return (
    <ExpandableIconRow
      icon={BubbleChatIcon}
      label="User input"
      detail={<InlineTextHint value={teaser} />}
      hasContent
      body={body}
    />
  );
}

/**
 * One question's answer formatted for display: selected option labels
 * joined with `, ` then optionally `· <other>` for free-text. Returns
 * `null` when the user submitted nothing (cancelled).
 */
function answerSummary(
  question: UserQuestion,
  answers: ReadonlyArray<UserQuestionAnswer>,
  index: number,
): React.ReactNode | null {
  const a = answers.find((x) => x.questionIndex === index);
  const picks = (a?.selected ?? []).map(
    (idx) => question.options[idx] ?? `#${idx}`,
  );
  const other = a?.other?.trim() ?? "";
  if (picks.length === 0 && other.length === 0) return null;
  return (
    <>
      {picks.length > 0 ? picks.join(", ") : null}
      {picks.length > 0 && other.length > 0 ? " · " : null}
      {other.length > 0 ? <span className="italic">{other}</span> : null}
    </>
  );
}

/** Plain-text version of `answerSummary` for clipboard export. */
function answerSummaryText(
  question: UserQuestion,
  answers: ReadonlyArray<UserQuestionAnswer>,
  index: number,
): string | null {
  const a = answers.find((x) => x.questionIndex === index);
  const picks = (a?.selected ?? []).map(
    (idx) => question.options[idx] ?? `#${idx}`,
  );
  const other = a?.other?.trim() ?? "";
  if (picks.length === 0 && other.length === 0) return null;
  const parts: string[] = [];
  if (picks.length > 0) parts.push(picks.join(", "));
  if (other.length > 0) parts.push(other);
  return parts.join(" · ");
}

export function ToolRow({
  tool,
  input,
  result,
}: {
  tool: string;
  input: unknown;
  result?: ToolResult;
}) {
  const view = buildToolView(tool, input, result);
  const pending = result === undefined;

  const sections: React.ReactNode[] = [];
  if (view.inputPanel !== undefined) {
    sections.push(<div key="input">{view.inputPanel}</div>);
  }
  if (view.fallbackBody !== undefined) {
    sections.push(<div key="fallback">{view.fallbackBody}</div>);
  }
  if (result !== undefined && view.resultPanel !== undefined) {
    const rendered = view.resultPanel(result);
    if (rendered !== null) {
      sections.push(
        <div key="result">
          {result.isError ? (
            <div className="mb-1 flex items-center">
              <ErrorPill />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Result
              </span>
            </div>
          ) : (
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Result
            </p>
          )}
          {rendered}
        </div>,
      );
    }
  }

  // Collapsed failure signal when the view didn't supply its own detail —
  // keeps the ErrorPill behind the chevron without per-case code.
  const detail =
    view.detail !== undefined ? (
      view.detail
    ) : result?.isError === true ? (
      <span className="text-[11px] text-destructive">error</span>
    ) : undefined;

  return (
    <ExpandableIconRow
      icon={view.icon}
      label={view.label}
      detail={detail}
      pending={pending}
      hasContent={sections.length > 0}
      body={sections.length > 0 ? sections : null}
    />
  );
}

export function ThinkingRow({
  text,
  redacted,
  pending = false,
}: {
  text: string;
  redacted: boolean;
  /** True while this thinking block is the live tip of a running turn. */
  pending?: boolean;
}) {
  // Three states:
  // 1. redacted — model thought but content is policy-hidden (rare;
  //    `redacted_thinking` content blocks).
  // 2. empty text — Anthropic's SDK / CLI receives the signature but
  //    strips every `thinking_delta` chunk before forwarding to us. The
  //    model did think, we just never see the words. We render a row
  //    anyway so the timeline accurately reflects what happened.
  // 3. plain text — render as markdown.
  const isEmpty = !redacted && text.length === 0;
  const body = redacted ? (
    <p className="whitespace-pre-wrap text-[11px] italic leading-relaxed text-muted-foreground/70">
      Thought content was redacted by the model.
    </p>
  ) : isEmpty ? (
    <p className="whitespace-pre-wrap text-[11px] italic leading-relaxed text-muted-foreground/70">
      The model produced a thinking block (the SDK forwarded its signed receipt)
      but the underlying text was filtered out by Anthropic&apos;s agent SDK
      before it reached us. We can&apos;t expose the actual thoughts without
      bypassing the official SDK.
    </p>
  ) : (
    <MarkdownBlock text={text} />
  );
  return (
    <ExpandableIconRow
      icon={Brain01Icon}
      label="Thinking"
      pending={pending}
      hasContent
      body={body}
    />
  );
}
