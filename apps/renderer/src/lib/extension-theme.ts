import type { ExtensionTheme } from "@zuse/extension-sdk";

const properties = {
	"--background": "background",
	"--foreground": "foreground",
	"--card": "card",
	"--card-foreground": "cardForeground",
	"--popover": "popover",
	"--popover-foreground": "popoverForeground",
	"--muted": "muted",
	"--muted-foreground": "mutedForeground",
	"--border": "border",
	"--input": "input",
	"--accent": "accent",
	"--accent-foreground": "accentForeground",
	"--destructive": "destructive",
	"--ring": "ring",
	"--primary": "accent",
	"--primary-foreground": "accentForeground",
	"--secondary": "muted",
	"--secondary-foreground": "foreground",
	"--sidebar": "background",
	"--sidebar-foreground": "foreground",
	"--sidebar-primary": "accent",
	"--sidebar-primary-foreground": "accentForeground",
	"--sidebar-accent": "muted",
	"--sidebar-accent-foreground": "foreground",
	"--sidebar-border": "border",
	"--sidebar-ring": "ring",
	"--bg-subtle": "card",
	"--bg-elevated": "muted",
	"--bg-overlay": "popover",
	"--text-faint": "mutedForeground",
	"--chip-bg": "input",
} as const satisfies Record<string, keyof ExtensionTheme["colors"]>;

export function applyExtensionTheme(
	style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">,
	theme: ExtensionTheme | undefined,
) {
	for (const [property, key] of Object.entries(properties)) {
		const value = theme?.colors[key];
		if (value === undefined) style.removeProperty(property);
		else style.setProperty(property, value);
	}
}
