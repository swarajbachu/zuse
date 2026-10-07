import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	authenticated: false,
	settingsReads: 0,
	failed: false,
}));
vi.mock("../../src/components/browser-access-gate.tsx", () => ({
	BrowserAccessGate: ({ children }: { children: ReactNode }) =>
		state.authenticated ? children : <button type="button">Sign in</button>,
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: () => {
		state.settingsReads++;
		return {
			loaded: false,
			phase: state.failed ? "error" : "connecting",
			error: state.failed
				? "Could not load workspace settings. Try again."
				: null,
			retry: () => undefined,
		};
	},
}));
vi.mock("../../src/lib/appearance.tsx", () => ({
	AppearanceController: () => null,
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
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
	it("keeps recovery available when organization settings fail, even with a native startup overlay", () => {
		state.authenticated = true;
		state.failed = true;
		observeRendererAccount("alice");
		selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
		try {
			for (const onStartupStateChange of [undefined, () => undefined]) {
				const markup = renderToStaticMarkup(
					<StartupApplication onStartupStateChange={onStartupStateChange} />,
				);
				expect(markup).toContain("Could not load workspace settings");
				expect(markup).toContain("Personal");
				expect(markup).toContain("Retry");
				expect(markup).not.toContain(
					"The local server did not become available",
				);
			}
		} finally {
			state.failed = false;
			observeRendererAccount(null);
		}
	});
	it("shows only a quiet Loading while organization settings first load", () => {
		state.authenticated = true;
		observeRendererAccount("alice");
		selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
		try {
			const markup = renderToStaticMarkup(<StartupApplication />);
			expect(markup).toContain('role="status"');
			expect(markup).toContain(">Loading<");
			// The Personal escape appears only after a slow load (5 s timer).
			expect(markup).not.toContain("Personal");
			expect(markup).not.toContain("Retry");
		} finally {
			observeRendererAccount(null);
		}
	});
});
