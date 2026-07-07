import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  MoreHorizontalIcon,
  PencilIcon,
  Search01Icon,
  UndoIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { Plus } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type Command,
  type KeybindingRule,
  keyStringFromEvent,
} from "@zuse/wire";

import { cn } from "~/lib/utils";
import {
  COMMAND_META,
  COMMANDS_IN_ORDER,
  DEFAULT_KEYBINDINGS,
} from "../../lib/default-keybindings";
import { useKeybindingsStore } from "../../store/keybindings";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Frame, FrameFooter, FrameHeader } from "../ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { KeybindingPill } from "./keybinding-pill";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPod|iPad/.test(navigator.userAgent);

/* ────────────────────── Row model — derived from store ───────────────────── */

type RuleSource = "Default" | "Custom";

interface EditorRow {
  readonly id: string;
  readonly source: RuleSource;
  readonly command: Command;
  readonly key: string;
  readonly userIndex: number | null;
  readonly defaultKey: string | null;
}

/* ──────────── per-row draft state — manages dirty edits in flight ───────── */

interface RowDraftState {
  readonly keyDraft: string;
  readonly isRecording: boolean;
}

type RowDraftAction =
  | { readonly type: "reset"; readonly row: EditorRow }
  | { readonly type: "patch"; readonly patch: Partial<RowDraftState> };

const draftFromRow = (row: EditorRow): RowDraftState => ({
  keyDraft: row.key,
  isRecording: false,
});

const draftReducer = (
  state: RowDraftState,
  action: RowDraftAction,
): RowDraftState => {
  if (action.type === "reset") return draftFromRow(action.row);
  return { ...state, ...action.patch };
};

/* ────────────────────────── Conflict labels ──────────────────────────────── */

/**
 * Return the labels of any rules (other than `self`) that bind the same
 * chord. With when-clauses gone from the UI the conflict check is just an
 * exact key match — the last-defined rule wins on press.
 */
function conflictsFor(
  rows: ReadonlyArray<EditorRow>,
  self: { readonly id: string; readonly key: string },
): ReadonlyArray<string> {
  const out: string[] = [];
  for (const row of rows) {
    if (row.id === self.id) continue;
    if (row.key !== self.key) continue;
    out.push(COMMAND_META[row.command].label);
  }
  return out;
}

/* ─────────────────────────── Recording surface ──────────────────────────── */

/**
 * Focusable surface that live-renders the currently-held modifiers as the
 * user reaches for the base key. Captures the full chord on the first
 * non-modifier press and fires `onCapture`; Escape and blur both call
 * `onExit` so the parent can drop back to its default display.
 */
function RecordingSurface({
  ariaLabel,
  onCapture,
  onExit,
}: {
  readonly ariaLabel: string;
  readonly onCapture: (key: string) => void;
  readonly onExit: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const updatePending = (event: ReactKeyboardEvent<HTMLElement>) => {
    const mods: string[] = [];
    if (IS_MAC) {
      if (event.metaKey) mods.push("mod");
      if (event.ctrlKey) mods.push("ctrl");
    } else {
      if (event.ctrlKey) mods.push("mod");
      if (event.metaKey) mods.push("meta");
    }
    if (event.altKey) mods.push("alt");
    if (event.shiftKey) mods.push("shift");
    setPending(mods.length > 0 ? mods.join("+") : null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setPending(null);
      onExit();
      return;
    }
    const captured = keyStringFromEvent(event.nativeEvent, IS_MAC);
    if (captured === null) {
      updatePending(event);
      return;
    }
    setPending(null);
    onCapture(captured);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setPending(null);
    }
  };

  return (
    <div
      tabIndex={0}
      autoFocus
      ref={(node) => node?.focus()}
      role="textbox"
      aria-label={ariaLabel}
      onBlur={() => {
        setPending(null);
        onExit();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-primary/70 bg-primary/5 px-2 text-[11px] font-medium text-primary outline-none ring-2 ring-primary/20"
    >
      {pending ? (
        <>
          <KeybindingPill value={pending} />
          <span className="text-primary/60">…</span>
        </>
      ) : (
        <span>Press shortcut…</span>
      )}
    </div>
  );
}

/* ─────────────────────────── Editor entrypoint ───────────────────────────── */

export function KeybindingsEditor() {
  const resolved = useKeybindingsStore((s) => s.resolvedRules);
  const userRules = useKeybindingsStore((s) => s.userRules);
  const loaded = useKeybindingsStore((s) => s.loaded);
  const hydrate = useKeybindingsStore((s) => s.hydrate);
  const error = useKeybindingsStore((s) => s.error);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const rows: ReadonlyArray<EditorRow> = useMemo(() => {
    const out: EditorRow[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      if (r === undefined) continue;
      const userIndex = userRules.indexOf(r.rule);
      const isCustom = userIndex !== -1;
      const defaultKey = findDefaultKey(r.rule.command);
      out.push({
        id: isCustom ? `user:${userIndex}` : `default:${r.rule.command}:${i}`,
        source: isCustom ? "Custom" : "Default",
        command: r.rule.command,
        key: r.rule.key,
        userIndex: isCustom ? userIndex : null,
        defaultKey,
      });
    }
    return out;
  }, [resolved, userRules]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter((row) => {
      const meta = COMMAND_META[row.command];
      return (
        meta.label.toLowerCase().includes(q) ||
        row.command.toLowerCase().includes(q) ||
        row.key.toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  return (
    <div className="flex flex-col gap-4">
      {error !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Failed to load keybindings: {error}
        </div>
      )}

      <Frame>
        <FrameHeader className="flex flex-row items-center justify-between px-2 py-2 w-full">
          <p className="text-sm font-semibold text-foreground">
            Keyboard shortcuts
          </p>
          <div className="flex items-center gap-1.5">
            <ExpandableSearch
              query={query}
              onQueryChange={setQuery}
              isOpen={searchOpen}
              onOpenChange={setSearchOpen}
              inputRef={searchRef}
              countLabel={`${rows.length} bindings`}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAdding(true)}
                    disabled={isAdding}
                    aria-label="Add keybinding"
                  >
                    <Plus className="size-3.5" strokeWidth={1.8} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add keybinding</TooltipPopup>
            </Tooltip>
          </div>
        </FrameHeader>

        <Card>
          <div className="grid grid-cols-[minmax(140px,1fr)_minmax(200px,1.2fr)_44px] border-b border-border/40 bg-muted/25 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            <div>Command</div>
            <div>Keybinding</div>
            <div className="text-right">Status</div>
          </div>
          <div className="divide-y divide-border/40">
            {!loaded && (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            )}
            {loaded && filtered.length === 0 && !isAdding && (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                {query.trim().length > 0
                  ? "No keybindings match your search."
                  : "No keybindings."}
              </div>
            )}
            {filtered.map((row) => (
              <RowEditor key={row.id} row={row} allRows={rows} />
            ))}
            {isAdding && (
              <NewRow
                allRows={rows}
                onCancel={() => setIsAdding(false)}
                onSaved={() => setIsAdding(false)}
              />
            )}
          </div>
        </Card>

        <FrameFooter className="px-2 py-1 w-full">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Click the pencil on any row to record a new chord. Bindings persist
            to{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              keybindings.json
            </code>{" "}
            in your app data folder; hand-edit there for advanced scoping.
          </p>
        </FrameFooter>
      </Frame>

      <ResetAllFooter />
    </div>
  );
}

/* ─────────────────── Existing-row editor ────────────────────────────────── */

function RowEditor({
  row,
  allRows,
}: {
  readonly row: EditorRow;
  readonly allRows: ReadonlyArray<EditorRow>;
}) {
  const [draft, dispatch] = useReducer(draftReducer, row, draftFromRow);
  const addRule = useKeybindingsStore((s) => s.addRule);
  const replaceUserRuleAt = useKeybindingsStore((s) => s.replaceUserRuleAt);
  const removeUserRuleAt = useKeybindingsStore((s) => s.removeUserRuleAt);
  const resetCommand = useKeybindingsStore((s) => s.resetCommand);

  // When the upstream row changes (e.g. saved → echoed back through stream),
  // reset the draft so the "dirty" indicator clears.
  useEffect(() => {
    dispatch({ type: "reset", row });
  }, [row]);

  const isDirty = draft.keyDraft !== row.key;
  const showPill = !draft.isRecording && draft.keyDraft.length > 0;

  const conflictLabels = conflictsFor(allRows, {
    id: row.id,
    key: draft.keyDraft,
  });

  const meta = COMMAND_META[row.command];
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";

  const save = async () => {
    const next: KeybindingRule = {
      key: draft.keyDraft,
      command: row.command,
    };
    if (row.source === "Custom" && row.userIndex !== null) {
      await replaceUserRuleAt(row.userIndex, next);
    } else {
      await addRule(next);
    }
  };

  return (
    <div className="grid grid-cols-[minmax(140px,1fr)_minmax(200px,1.2fr)_44px] items-center px-3 py-1.5 text-sm even:bg-muted/15 hover:bg-accent/40">
      <div className="min-w-0 pr-4">
        <div
          className="truncate text-[13px] font-medium text-foreground"
          title={row.command}
        >
          {meta.label}
        </div>
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={row.command}
        >
          {meta.group}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-1 pr-3">
        {showPill ? (
          <>
            <div
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto rounded-md border px-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                isDirty
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent",
              )}
            >
              <KeybindingPill value={draft.keyDraft} />
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      dispatch({
                        type: "patch",
                        patch: { isRecording: true },
                      })
                    }
                    aria-label={`Edit shortcut for ${meta.label}`}
                  >
                    <HugeiconsIcon icon={PencilIcon} className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Record new chord</TooltipPopup>
            </Tooltip>
            {isDirty && (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => dispatch({ type: "reset", row })}
                        aria-label="Discard pending changes"
                      >
                        <HugeiconsIcon icon={UndoIcon} className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Discard changes</TooltipPopup>
                </Tooltip>
                <Button
                  size="xs"
                  className="h-7 shrink-0"
                  disabled={draft.keyDraft.trim().length === 0}
                  onClick={() => void save()}
                >
                  Save
                </Button>
              </>
            )}
          </>
        ) : (
          <RecordingSurface
            ariaLabel={`Recording shortcut for ${meta.label}`}
            onCapture={(key) =>
              dispatch({
                type: "patch",
                patch: { keyDraft: key, isRecording: false },
              })
            }
            onExit={() =>
              dispatch({ type: "patch", patch: { isRecording: false } })
            }
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-1">
        <ConflictWarning labels={conflictLabels} />
        {(canReset || canRemove) && (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  aria-label={`Actions for ${meta.label}`}
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-36">
              {canReset && (
                <MenuItem onClick={() => void resetCommand(row.command)}>
                  Reset to default
                </MenuItem>
              )}
              {canRemove && (
                <MenuItem
                  className="text-destructive"
                  onClick={() => {
                    if (row.userIndex !== null)
                      void removeUserRuleAt(row.userIndex);
                  }}
                >
                  Remove
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
    </div>
  );
}

/* ─────────────────── New-binding row ─────────────────────────────────────── */

function NewRow({
  allRows,
  onCancel,
  onSaved,
}: {
  readonly allRows: ReadonlyArray<EditorRow>;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const addRule = useKeybindingsStore((s) => s.addRule);
  const [command, setCommand] = useState<Command>(
    COMMANDS_IN_ORDER[0] ?? "new-chat",
  );
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => ({
    keyDraft: "",
    isRecording: true,
  }));

  const conflictLabels = conflictsFor(allRows, {
    id: "new",
    key: draft.keyDraft,
  });

  const canSave = draft.keyDraft.trim().length > 0;

  const save = async () => {
    await addRule({ key: draft.keyDraft, command });
    onSaved();
  };

  // Free-flowing flex layout so the Add / Cancel buttons can't be
  // clipped by a narrow table column.
  return (
    <div className="flex flex-col gap-2 bg-accent/20 px-3 py-3 text-sm">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.07em] text-muted-foreground">
        <Plus className="size-3" strokeWidth={1.8} /> New binding
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={command} onValueChange={(v) => setCommand(v as Command)}>
          <SelectTrigger
            size="sm"
            className="h-7 min-h-7 min-w-[10rem] flex-1 rounded-md text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {COMMANDS_IN_ORDER.map((cmd) => (
              <SelectItem key={cmd} value={cmd} className="text-xs">
                <span className="flex flex-col">
                  <span>{COMMAND_META[cmd].label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {COMMAND_META[cmd].group}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex min-w-0 items-center gap-1">
          {draft.isRecording ? (
            <RecordingSurface
              ariaLabel="Recording shortcut for new binding"
              onCapture={(key) =>
                dispatch({
                  type: "patch",
                  patch: { keyDraft: key, isRecording: false },
                })
              }
              onExit={() =>
                dispatch({ type: "patch", patch: { isRecording: false } })
              }
            />
          ) : draft.keyDraft.length > 0 ? (
            <>
              <div className="flex h-7 min-w-0 items-center gap-1.5 overflow-x-auto rounded-md border border-primary/40 bg-primary/5 px-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <KeybindingPill value={draft.keyDraft} />
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        dispatch({
                          type: "patch",
                          patch: { isRecording: true },
                        })
                      }
                      aria-label="Re-record shortcut for new binding"
                    >
                      <HugeiconsIcon icon={PencilIcon} className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Record again</TooltipPopup>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "patch", patch: { isRecording: true } })
              }
              aria-label="Record shortcut for new binding"
              className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <HugeiconsIcon icon={PencilIcon} className="size-3" />
              Click to record
            </button>
          )}
        </div>

        <ConflictWarning labels={conflictLabels} />

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            className="h-7 px-2 text-muted-foreground hover:text-foreground"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            className="h-7"
            disabled={!canSave}
            onClick={() => void save()}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Conflict warning bubble ───────────────────────────── */

function ConflictWarning({
  labels,
}: {
  readonly labels: ReadonlyArray<string>;
}) {
  if (labels.length === 0) return null;
  const description =
    labels.length === 1
      ? `Conflicts with ${labels[0]}.`
      : `Conflicts with ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and more" : ""}.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={description}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-amber-500 outline-none transition-colors hover:bg-amber-500/10 focus-visible:ring-[3px] focus-visible:ring-amber-500/25"
          >
            <HugeiconsIcon icon={Alert01Icon} className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-72 whitespace-normal leading-relaxed"
      >
        {description} The most recent matching binding wins when both fire on
        the same chord.
      </TooltipPopup>
    </Tooltip>
  );
}

/* ─────────────────── Expandable header search ──────────────────────────── */

function ExpandableSearch({
  query,
  onQueryChange,
  isOpen,
  onOpenChange,
  inputRef,
  countLabel,
}: {
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly countLabel: string;
}) {
  if (!isOpen) {
    return (
      <>
        <span className="text-[11px] text-muted-foreground/70">
          {countLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onOpenChange(true)}
                aria-label="Search keybindings"
              >
                <HugeiconsIcon icon={Search01Icon} className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="top">Search keybindings</TooltipPopup>
        </Tooltip>
      </>
    );
  }
  return (
    <div className="relative">
      <HugeiconsIcon
        icon={Search01Icon}
        className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        onBlur={() => {
          if (query.length === 0) onOpenChange(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onQueryChange("");
            onOpenChange(false);
          }
        }}
        placeholder="Search keybindings"
        aria-label="Search keybindings"
        className="h-6 w-44 rounded-md border border-input bg-background pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
      />
    </div>
  );
}

/* ─────────────────── Reset-all footer (only with overrides) ────────────── */

function ResetAllFooter() {
  const userRulesCount = useKeybindingsStore((s) => s.userRules.length);
  const resetAll = useKeybindingsStore((s) => s.resetAll);
  if (userRulesCount === 0) return null;
  return (
    <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs">
      <span className="text-muted-foreground">
        {userRulesCount} custom rule{userRulesCount === 1 ? "" : "s"} active.
      </span>
      <Button variant="settings" size="sm" onClick={() => void resetAll()}>
        Reset all to defaults
      </Button>
    </div>
  );
}

/* ─────────────────── Wrapper used by settings-page.tsx ─────────────────── */

export function KeybindingsPane() {
  return (
    <div className="flex flex-col gap-4">
      <KeybindingsEditor />
    </div>
  );
}

/* ─────────────────── helpers ────────────────────────────────────────────── */

function findDefaultKey(command: Command): string | null {
  for (const r of DEFAULT_KEYBINDINGS) {
    if (r.command === command) return r.key;
  }
  return null;
}
