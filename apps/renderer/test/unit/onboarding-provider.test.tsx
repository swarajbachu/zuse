import type { AgentAvailability } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	availability: [] as AgentAvailability[],
	loading: false,
	availabilityLoaded: true,
	refresh: vi.fn(),
	defaultProviderId: "pi",
	setDefaultProvider: vi.fn(),
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: (selector: (value: typeof state) => unknown) =>
		selector(state),
}));
vi.mock("../../src/store/providers.ts", () => ({
	useProvidersStore: (selector: (value: typeof state) => unknown) =>
		selector(state),
}));
vi.mock("../../src/components/settings-page.tsx", () => ({
	PROVIDER_LABEL: { pi: "Pi", claude: "Claude Code" },
}));
vi.mock("../../src/components/api-key-row.tsx", () => ({
	ApiKeyRow: () => <div>API key form</div>,
}));
vi.mock("../../src/components/provider-icons.tsx", () => ({
	ProviderIcon: () => null,
}));

import { ProviderStep } from "../../src/components/onboarding/steps/provider.tsx";

beforeEach(() => {
	state.defaultProviderId = "pi";
	state.loading = false;
	state.availabilityLoaded = true;
	state.availability = [
		{
			providerId: "pi",
			displayName: "Pi",
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
			authStatus: "unknown",
		},
	];
});
it("shows installed Pi as available without claiming authenticated access", () => {
	const html = renderToStaticMarkup(<ProviderStep />);
	expect(html).toContain("AVAILABLE");
	expect(html).toContain("Pi manages authentication and tool permissions");
	expect(html).toContain("<code>pi</code>");
	expect(html).toContain("<code>/login</code>");
	expect(html).not.toContain("Sign in to the CLI");
	expect(html).not.toContain("CLI logged in");
	expect(html).not.toContain("API key form");
});
it("shows the shared install command for missing Pi without an API key form", () => {
	state.availability = state.availability.map((entry) => ({
		...entry,
		cliInstalled: false,
	}));
	const html = renderToStaticMarkup(<ProviderStep />);
	expect(html).toContain(
		"npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
	);
	expect(html).not.toContain("API key form");
});
it("keeps outdated Pi actionable before the native-auth state", () => {
	state.availability = state.availability.map((entry) => ({
		...entry,
		cliVersionStatus: "outdated",
	}));
	const html = renderToStaticMarkup(<ProviderStep />);
	expect(html).toContain("Update the CLI");
	expect(html).not.toContain("API key form");
});
it("retains generic sign-in guidance for other providers", () => {
	state.defaultProviderId = "claude";
	state.availability = [
		{
			providerId: "claude",
			displayName: "Claude Code",
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
		},
	];
	const html = renderToStaticMarkup(<ProviderStep />);
	expect(html).toContain("Sign in to the CLI");
	expect(html).toContain("claude /login");
	expect(html).toContain("API key form");
});
