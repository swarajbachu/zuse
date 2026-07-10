import { type EditorView } from "@codemirror/view";
import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useState } from "react";

import type { ProviderId, Skill } from "@zuse/contracts";

import {
  filterBuiltins,
  type BuiltinCommand,
} from "../../composer/builtin-commands.ts";
import {
  replaceWithChip,
  type ActiveTrigger,
} from "~/lib/codemirror/composer";
import { useSkillsStore } from "~/store/skills.ts";
import { cn } from "~/lib/utils";

export interface SlashCommandPopoverProps {
  readonly trigger: ActiveTrigger;
  readonly view: EditorView;
  readonly sessionId: string;
  readonly providerId: ProviderId;
  readonly onClose: () => void;
}

interface BuiltinRow {
  readonly kind: "builtin";
  readonly command: BuiltinCommand;
}

interface SkillRow {
  readonly kind: "skill";
  readonly skill: Skill;
}

type Row = BuiltinRow | SkillRow;

const filterSkills = (
  skills: ReadonlyArray<Skill>,
  query: string,
): ReadonlyArray<Skill> => {
  if (skills.length === 0) return skills;
  if (!query) return skills;
  const ranked = fuzzysort.go(query, skills, {
    keys: ["name", "description"],
    threshold: 0.3,
    limit: 50,
  });
  return ranked.map((r) => r.obj);
};

/**
 * Slash popover. Single flat list — built-ins first, then disk skills.
 * No section headers, no leading icon, full-width rows; the screenshot
 * spec is a clean monospace `/name` followed by description on the same line.
 */
export function SlashCommandPopover({
  trigger,
  view,
  sessionId,
  providerId,
  onClose,
}: SlashCommandPopoverProps) {
  const allSkills = useSkillsStore(
    (s) => s.skillsBySession[sessionId] ?? EMPTY_SKILLS,
  );

  const builtins = useMemo(
    () => filterBuiltins(trigger.query, providerId),
    [trigger.query, providerId],
  );
  const skills = useMemo(
    () => filterSkills(allSkills, trigger.query),
    [allSkills, trigger.query],
  );

  const rows = useMemo<ReadonlyArray<Row>>(
    () => [
      ...builtins.map((c) => ({ kind: "builtin" as const, command: c })),
      ...skills.map((s) => ({ kind: "skill" as const, skill: s })),
    ],
    [builtins, skills],
  );

  const [highlight, setHighlight] = useState(0);
  useEffect(() => setHighlight(0), [rows]);

  const confirmRow = (row: Row) => {
    if (row.kind === "builtin") {
      const cmd = row.command;
      if (cmd.kind === "client") {
        // Client-handled built-ins stay as plain text so submit's matchBuiltin
        // path triggers (`/clear`, `/model`, etc.).
        view.dispatch({
          changes: {
            from: trigger.from,
            to: trigger.to,
            insert: `/${cmd.name} `,
          },
          selection: { anchor: trigger.from + cmd.name.length + 2 },
        });
        view.focus();
      } else {
        // Provider built-ins are sent as plain leading slash text. The server
        // provider intercepts them before the normal model-turn path.
        view.dispatch({
          changes: {
            from: trigger.from,
            to: trigger.to,
            insert: `/${cmd.name} `,
          },
          selection: { anchor: trigger.from + cmd.name.length + 2 },
        });
        view.focus();
      }
    } else {
      replaceWithChip(view, trigger.from, trigger.to, `/${row.skill.name}`, {
        kind: "skill",
        name: row.skill.name,
        scope: row.skill.scope,
      });
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rows.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (h + 1) % rows.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (h - 1 + rows.length) % rows.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const row = rows[highlight];
        if (row !== undefined) confirmRow(row);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, highlight, onClose]);

  if (rows.length === 0) return null;

  return (
    <div
      role="listbox"
      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-80 overflow-y-auto rounded-lg border border-border/60 bg-popover py-1 shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      {rows.map((row, i) => {
        const active = i === highlight;
        const name = row.kind === "builtin" ? row.command.name : row.skill.name;
        const description =
          row.kind === "builtin" ? row.command.description : row.skill.description;
        const key =
          row.kind === "builtin"
            ? `b:${row.command.name}`
            : `s:${row.skill.scope}:${row.skill.name}`;
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={active}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => confirmRow(row)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm",
              active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
            )}
          >
            <span className="font-mono text-foreground">/{name}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">
              {description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const EMPTY_SKILLS: ReadonlyArray<Skill> = [];
