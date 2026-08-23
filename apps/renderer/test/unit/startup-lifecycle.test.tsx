import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	SLOW_STARTUP_DELAY_MS,
	StartupSurface,
	sanitizeStartupError,
	startupPresentation,
} from "../../src/components/startup-surface.tsx";

describe("startup lifecycle", () => {
	it("never treats unresolved settings as onboarding", () => {
		expect(
			startupPresentation({ loaded: false, phase: "initial-loading" }),
		).toBe("loading");
		expect(startupPresentation({ loaded: false, phase: "connecting" })).toBe(
			"loading",
		);
	});

	it("shows recovery only for a terminal startup failure without settings", () => {
		expect(startupPresentation({ loaded: false, phase: "error" })).toBe(
			"error",
		);
		expect(startupPresentation({ loaded: true, phase: "offline-stale" })).toBe(
			"ready",
		);
	});

	it("uses the agreed slow-start threshold", () => {
		expect(SLOW_STARTUP_DELAY_MS).toBe(4_000);
	});

	it("sanitizes startup diagnostics before displaying or copying them", () => {
		expect(
			sanitizeStartupError(
				"Failed at /Users/alice/zuse/settings.json?token=secret-value with ghp_abc123",
			),
		).toBe("Failed at [local path]?token=[redacted] with [redacted]");
	});

	it("renders an accessible branded loader", () => {
		const markup = renderToStaticMarkup(
			<StartupSurface
				error={null}
				phase="initial-loading"
				onRetry={() => {}}
			/>,
		);
		expect(markup).toContain('aria-label="Loading Zuse"');
		expect(markup).toContain("Zuse");
		expect(markup).not.toContain("Onboarding");
	});

	it("renders retry, reload, and diagnostic-copy controls after failure", () => {
		const markup = renderToStaticMarkup(
			<StartupSurface
				error="Server unavailable"
				phase="error"
				onRetry={() => {}}
			/>,
		);
		expect(markup).toContain("Zuse couldn’t start");
		expect(markup).toContain("Try again");
		expect(markup).toContain("Reload");
		expect(markup).toContain("Copy details");
	});
});
