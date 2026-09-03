import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CloudAccountAccess } from "../../src/components/settings/cloud-account-access.tsx";
import {
	runtimePhaseLabel,
	runtimeVersionDescription,
} from "../../src/components/settings/cloud-machines-pane.tsx";

describe("CloudAccountAccess", () => {
	it("renders target-machine provider setup without local-import language", () => {
		const markup = renderToStaticMarkup(
			<CloudAccountAccess environmentId="env-cloud" />,
		);

		expect(markup).toContain("Agent access");
		expect(markup).toContain("Nothing is copied from this Mac.");
		expect(markup).toContain("Agent tools");
		expect(markup).toContain("Checking installed agent tools.");
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).toContain("Cursor");
		expect(markup).toContain("Grok");
		expect(markup.match(/>Set up<\/button>/gu)).toHaveLength(4);
		expect(markup).toContain('aria-label="Refresh agent authorization"');
		expect(markup).toContain('aria-live="polite"');
		expect(markup).not.toContain("auth.json");
		expect(markup).not.toContain("transfer");
	});

	it("keeps setup visible before the persistent cloud computer exists", () => {
		const markup = renderToStaticMarkup(<CloudAccountAccess />);

		expect(markup).toContain("Cloud computer required");
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).toContain("Cursor");
		expect(markup).toContain("Grok");
		expect(markup.match(/>Not available</gu)).toHaveLength(4);
		expect(markup).toContain('disabled=""');
		expect(markup).not.toContain("Transfer to cloud");
	});
});

describe("cloud runtime update progress", () => {
	it("uses stable progress and rollback copy", () => {
		expect(
			runtimePhaseLabel({
				state: "updating",
				phase: "restarting",
				progressPercent: 85,
				targetAppVersion: "0.17.1",
			}),
		).toBe("Restarting cloud services");
		expect(
			runtimePhaseLabel({
				state: "failed",
				phase: "failed",
				progressPercent: 95,
				targetAppVersion: "0.17.1",
				failureCode: "rollback-complete",
			}),
		).toBe("Update failed; previous version restored");
	});

	it("shows the installed and target Zuse versions", () => {
		expect(
			runtimeVersionDescription({
				state: "update-available",
				phase: "idle",
				progressPercent: 0,
				targetAppVersion: "0.17.1",
				installedAppVersion: "0.16.0",
			}),
		).toBe("Installed Zuse 0.16.0; desktop requires 0.17.1.");
		expect(
			runtimeVersionDescription({
				state: "current",
				phase: "idle",
				progressPercent: 100,
				targetAppVersion: "0.17.1",
				installedAppVersion: "0.17.1",
			}),
		).toBe("Installed Zuse 0.17.1. This matches the desktop app.");
	});
});
