import { expect, it } from "vitest";
import { theme as ocean } from "../../../../extensions/midnight-ocean/index.client.ts";
import { theme as paper } from "../../../../extensions/warm-paper/index.client.ts";
import { applyExtensionTheme } from "../../src/lib/extension-theme.ts";

it("applies the selected palette to navigation and controls and clears it on fallback", () => {
	const values = new Map<string, string>([["--unrelated", "preserved"]]);
	const style = {
		setProperty: (key: string, value: string) => {
			values.set(key, value);
		},
		removeProperty: (key: string) => {
			const old = values.get(key) ?? "";
			values.delete(key);
			return old;
		},
	};
	applyExtensionTheme(style, ocean.theme);
	expect(values.get("--sidebar")).toBe(ocean.theme.colors.background);
	expect(values.get("--primary")).toBe(ocean.theme.colors.accent);
	expect(values.get("--primary-foreground")).toBe(
		ocean.theme.colors.accentForeground,
	);
	expect(values.get("--bg-elevated")).toBe(ocean.theme.colors.muted);
	applyExtensionTheme(style, paper.theme);
	expect(values.get("--sidebar")).toBe(paper.theme.colors.background);
	expect(values.get("--primary")).toBe(paper.theme.colors.accent);
	applyExtensionTheme(style, undefined);
	expect([...values]).toEqual([["--unrelated", "preserved"]]);
});
