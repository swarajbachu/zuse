import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoTraceLoader } from "../../src/components/logo-trace-loader.tsx";
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
		expect(markup.match(/role="status"/g)).toHaveLength(1);
		expect(markup).toContain('viewBox="0 0 1254 1254"');
		expect(markup).toContain('stroke="currentColor"');
		expect(markup).toContain('data-logo-trace-path=""');
		expect(markup).toContain('d="M455 585 L570 440');
		expect(markup).toContain('d="M5730 8469');
		expect(markup).not.toContain('stroke-dasharray="0.16 0.84"');
		expect(markup).not.toContain("animate-spin");
		expect(markup).not.toContain("Onboarding");
	});

	it("starts the closing Z trace when work is already complete", () => {
		const markup = renderToStaticMarkup(
			<LogoTraceLoader
				ariaLabel="Opening Zuse"
				isComplete
				size={64}
				strokeWidth={36}
			/>,
		);
		expect(markup).toContain('aria-label="Opening Zuse"');
		expect(markup).toContain('width="64"');
		expect(markup).toContain('height="64"');
		expect(markup).toContain('stroke-dasharray="1"');
		expect(markup).not.toContain('stroke-dasharray="0.16 0.84"');
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
