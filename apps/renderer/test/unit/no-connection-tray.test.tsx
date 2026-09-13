import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { NoConnectionTray } from "../../src/components/composer/no-connection-tray.tsx";
import { setPlatformOnlineForTest } from "../../src/lib/network-status.ts";

describe("NoConnectionTray", () => {
	afterEach(() => {
		setPlatformOnlineForTest(true);
	});

	it("renders nothing while the platform is online", () => {
		setPlatformOnlineForTest(true);
		expect(renderToStaticMarkup(<NoConnectionTray />)).toBe("");
	});

	it("shows the No connection pill while offline", () => {
		setPlatformOnlineForTest(false);
		const markup = renderToStaticMarkup(<NoConnectionTray />);
		expect(markup).toContain("No connection");
		expect(markup).toContain('role="status"');
	});

	it("renders as a flush composer tray row", () => {
		setPlatformOnlineForTest(false);
		const markup = renderToStaticMarkup(<NoConnectionTray />);
		expect(markup).toContain("border-b border-border/35");
		expect(markup).not.toContain("bg-alert-error-bg");
	});
});
