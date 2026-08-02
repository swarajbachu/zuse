import type * as React from "react";
import { isMacHost } from "~/lib/host-platform";
import { cn } from "~/lib/utils";
import { Kbd, KbdGroup } from "../ui/kbd";

const IS_MAC = isMacHost();
/**
 * Render a `mod+shift+n`-style key string as a row of `<Kbd>` pills,
 * with platform-correct glyphs for the modifier tokens. Reads like the
 * shortcut you'd see in a menu.
 *
 * Unknown / malformed strings render as-is — the editor flags the row
 * separately, and showing the user what they typed is better than
 * silently dropping it.
 */
export function KeybindingPill({
	value,
	className,
}: {
	readonly value: string;
	readonly className?: string;
}): React.ReactElement {
	const parts = value
		.split("+")
		.map((p) => p.trim())
		.filter(Boolean);
	return (
		<KbdGroup
			className={cn("shrink-0 bg-transparent p-0 shadow-none", className)}
		>
			{parts.map((part, i) => (
				<Kbd
					key={`${part}-${i}`}
					className="min-w-6 shrink-0 justify-center px-1.5"
				>
					{renderTokenForDisplay(part)}
				</Kbd>
			))}
		</KbdGroup>
	);
}

function renderTokenForDisplay(token: string): string {
	const lower = token.toLowerCase();
	if (lower === "mod") return IS_MAC ? "⌘" : "Ctrl";
	if (lower === "cmd" || lower === "meta" || lower === "command") {
		return IS_MAC ? "⌘" : "Win";
	}
	if (lower === "ctrl" || lower === "control") return IS_MAC ? "⌃" : "Ctrl";
	if (lower === "alt" || lower === "option" || lower === "opt") {
		return IS_MAC ? "⌥" : "Alt";
	}
	if (lower === "shift") return IS_MAC ? "⇧" : "Shift";
	if (lower === "enter" || lower === "return") return "↵";
	if (lower === "tab") return "⇥";
	if (lower === "backspace") return "⌫";
	if (lower === "delete") return "⌦";
	if (lower === "escape" || lower === "esc") return "Esc";
	if (lower === "up") return "↑";
	if (lower === "down") return "↓";
	if (lower === "left") return "←";
	if (lower === "right") return "→";
	if (lower === "space" || token === " ") return "Space";
	return token.length === 1 ? token.toUpperCase() : token;
}
