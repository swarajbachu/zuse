import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ authenticated: false, settingsReads: 0 }));
vi.mock("../../src/components/browser-access-gate.tsx", () => ({
	BrowserAccessGate: ({ children }: { children: ReactNode }) =>
		state.authenticated ? children : <button type="button">Sign in</button>,
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: () => {
		state.settingsReads++;
		return {
			loaded: false,
			phase: "connecting",
			error: null,
			retry: () => undefined,
		};
	},
}));
vi.mock("../../src/lib/appearance.tsx", () => ({
	AppearanceController: () => null,
}));

import { StartupApplication } from "../../src/startup-application.tsx";

describe("browser startup ordering", () => {
	it("allows sign-in before reading server settings", () => {
		state.authenticated = false;
		state.settingsReads = 0;
		expect(renderToStaticMarkup(<StartupApplication />)).toContain("Sign in");
		expect(state.settingsReads).toBe(0);
		state.authenticated = true;
		expect(renderToStaticMarkup(<StartupApplication />)).toContain(
			"Loading Zuse",
		);
		expect(state.settingsReads).toBe(1);
	});
});
