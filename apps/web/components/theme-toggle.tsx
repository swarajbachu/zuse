"use client";

import { IconMoonFilled, IconSunFilled } from "@tabler/icons-react";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle({ className }: { className?: string }) {
	const { message } = useWebsiteMessages();
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	// Keep the server and first client render identical, including when a
	// returning visitor has a light-theme preference in local storage.
	const isDark = !mounted || resolvedTheme !== "light";
	return (
		<button
			type="button"
			aria-label={message(
				isDark ? "navigation:light_theme" : "navigation:dark_theme",
			)}
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className={
				className ??
				"border-border bg-card text-muted-foreground hover:bg-elevated hover:text-heading focus-visible:ring-heading/60 relative flex size-6 items-center justify-center rounded-md border transition-colors duration-200 after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:outline-none"
			}
		>
			{isDark ? (
				<IconSunFilled aria-hidden="true" className="size-3" />
			) : (
				<IconMoonFilled aria-hidden="true" className="size-3" />
			)}
		</button>
	);
}
