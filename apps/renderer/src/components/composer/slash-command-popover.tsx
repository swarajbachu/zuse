import type { EditorView } from "@codemirror/view";
import { EnvironmentId, type ProviderId, type Skill } from "@zuse/contracts";
import fuzzysort from "fuzzysort";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useComposerAnchor } from "~/components/composer/use-composer-anchor";
import { SkillIcon } from "~/components/skill-icon.tsx";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { type ActiveTrigger, replaceWithChip } from "~/lib/codemirror/composer";
import { useSessionSkills } from "~/lib/session-skills-client-bus.ts";
import { cn } from "~/lib/utils";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog.ts";
import { useSessionsStore } from "~/store/sessions.ts";
import {
	type BuiltinCommand,
	filterBuiltins,
} from "../../composer/builtin-commands.ts";

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
 * Shared command/skill popover. Slash triggers show commands and dollar
 * triggers show skills, keeping both namespaces predictable.
 */
export function SlashCommandPopover({
	trigger,
	view,
	sessionId,
	providerId,
	onClose,
}: SlashCommandPopoverProps) {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const draftSkills = useSessionsStore((state) =>
		state.draftSession?.id === sessionId ? state.draftSkills : null,
	);
	const skillsView = useSessionSkills(
		{
			environmentId,
			sessionId: sessionId as import("@zuse/contracts").SessionId,
		},
		draftSkills === null && trigger.kind === "dollar"
			? "connect"
			: "cache-only",
	);
	const allSkills = draftSkills ?? skillsView.data?.skills ?? EMPTY_SKILLS;

	const builtins = useMemo(
		() =>
			trigger.kind === "slash"
				? filterBuiltins(trigger.query, providerId)
				: [],
		[trigger.kind, trigger.query, providerId],
	);
	const skills = useMemo(
		() =>
			trigger.kind === "dollar"
				? filterSkills(allSkills, trigger.query)
				: [],
		[allSkills, trigger.kind, trigger.query],
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
			replaceWithChip(view, trigger.from, trigger.to, `$${row.skill.name}`, {
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

	const anchor = useComposerAnchor(view);

	if (rows.length === 0 || anchor === null) return null;

	// Portaled to body: inside the composer the glass blur can't sample the
	// page (nested backdrop-filter roots), so the popup escapes it.
	return createPortal(
		<div
			role="listbox"
			className={cn(
				"fixed z-50 max-h-80 overflow-y-auto p-1.5",
				overlaySurface,
			)}
			style={{
				left: anchor.left,
				bottom: anchor.bottom,
				width: anchor.width,
			}}
			onMouseDown={(e) => e.preventDefault()}
		>
			{rows.map((row, i) => {
				const active = i === highlight;
				const name = row.kind === "builtin" ? row.command.name : row.skill.name;
				const prefix = row.kind === "skill" ? "" : "/";
				const description =
					row.kind === "builtin"
						? row.command.description
						: row.skill.description;
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
							"flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm",
							active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
						)}
					>
						{row.kind === "skill" ? (
							<SkillIcon className="size-3.5 text-primary/75" />
						) : null}
						<span className="font-mono text-foreground">
							{prefix}
							{name}
						</span>
						<span className="flex-1 truncate text-xs text-muted-foreground">
							{description}
						</span>
					</button>
				);
			})}
		</div>,
		document.body,
	);
}

const EMPTY_SKILLS: ReadonlyArray<Skill> = [];
