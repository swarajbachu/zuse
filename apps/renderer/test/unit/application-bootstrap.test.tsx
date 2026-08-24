import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { useSettingsStore } = vi.hoisted(() => ({
	useSettingsStore: vi.fn(
		(selector: (state: Record<string, unknown>) => unknown) =>
			selector({
				error: null,
				loaded: false,
				onboardingCompleted: false,
				origin: "none",
				phase: "initial-loading",
				retry: vi.fn(),
			}),
	),
}));

vi.mock("../../src/lib/settings-client-bus.ts", () => ({ useSettingsStore }));
vi.mock("../../src/lib/appearance.tsx", () => ({
	AppearanceController: () => null,
}));

import { StartupApplication } from "../../src/startup-application.tsx";

describe("application bootstrap", () => {
	it("mounts settings readiness before the full application chunk", () => {
		const markup = renderToStaticMarkup(<StartupApplication />);

		expect(useSettingsStore).toHaveBeenCalledOnce();
		expect(markup).toContain('aria-label="Loading Zuse"');
	});
});
