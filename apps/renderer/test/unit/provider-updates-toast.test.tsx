import type { AgentAvailability, ProviderId } from "@zuse/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderUpdatesToast } from "../../src/components/provider-updates-toast.tsx";

const state = vi.hoisted(() => ({
	settings: {
		providerUpdateNotificationsEnabled: true,
		providerEnabled: {} as Partial<Record<ProviderId, boolean>>,
	},
	providers: { availability: [] as AgentAvailability[] },
	ui: { setView: vi.fn(), setSettingsSection: vi.fn() },
}));

vi.mock("~/lib/settings-client-bus", () => ({
	useSettingsStore: (select: (settings: typeof state.settings) => unknown) =>
		select(state.settings),
}));
vi.mock("~/store/providers", () => ({
	useProvidersStore: (select: (providers: typeof state.providers) => unknown) =>
		select(state.providers),
}));
vi.mock("~/store/ui", () => ({
	useUiStore: (select: (ui: typeof state.ui) => unknown) => select(state.ui),
}));
vi.mock("react-dom", () => ({
	createPortal: (children: ReactNode) => children,
}));

const provider = (
	providerId: ProviderId,
	displayName: string,
	latestVersionStatus: AgentAvailability["latestVersionStatus"] = "behind",
): AgentAvailability => ({
	providerId,
	displayName,
	cliInstalled: true,
	cliLoggedIn: true,
	hasApiKey: false,
	latestVersion: "2.0.0",
	latestVersionStatus,
});

const renderToast = () => renderToStaticMarkup(<ProviderUpdatesToast />);

beforeEach(() => {
	state.settings.providerUpdateNotificationsEnabled = true;
	state.settings.providerEnabled = {};
	state.providers.availability = [provider("claude", "Claude")];
	vi.stubGlobal("window", { localStorage: { getItem: () => null } });
	vi.stubGlobal("document", { body: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe("provider update notifications", () => {
	it("hides updates when the provider is toggled off", () => {
		state.settings.providerEnabled = { claude: false };
		expect(renderToast()).toBe("");
	});

	it("only counts and names enabled providers with updates", () => {
		state.providers.availability = [
			provider("claude", "Claude"),
			provider("codex", "Codex"),
			provider("gemini", "Gemini"),
			provider("cursor", "Cursor", "current"),
		];
		state.settings.providerEnabled = {
			claude: true,
			codex: false,
			gemini: true,
			cursor: true,
		};
		const markup = renderToast();
		expect(markup).toContain("Updates available: 2 providers");
		expect(markup).toContain("Claude v2.0.0, Gemini v2.0.0");
		expect(markup).not.toContain("Codex");
		expect(markup).not.toContain("Cursor");
	});

	it("uses the enabled default when a provider has no saved toggle", () => {
		expect(renderToast()).toContain("Update available: Claude v2.0.0");
	});

	it("respects the global notification toggle", () => {
		state.settings.providerUpdateNotificationsEnabled = false;
		expect(renderToast()).toBe("");
	});

	it("builds dismissal keys using only enabled providers", () => {
		state.providers.availability.push(provider("codex", "Codex"));
		state.settings.providerEnabled = { claude: true, codex: false };
		vi.stubGlobal("window", {
			localStorage: { getItem: () => '["claude:2.0.0"]' },
		});
		expect(renderToast()).toBe("");
	});
});
