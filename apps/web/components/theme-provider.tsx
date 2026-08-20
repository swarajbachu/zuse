"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * App-wide theme provider. Defaults to dark (Zuse's identity) so every existing
 * page is unchanged; pages that opt into a toggle can switch to light.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
	return (
		<NextThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			disableTransitionOnChange
		>
			{children}
		</NextThemeProvider>
	);
};
