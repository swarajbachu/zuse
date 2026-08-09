import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CloudAccountAccess } from "../../src/components/settings/cloud-account-access.tsx";
import { runtimePhaseLabel } from "../../src/components/settings/cloud-machines-pane.tsx";

describe("CloudAccountAccess", () => {
	it("renders a stable keyboard-operable setup checklist without secret inputs", () => {
		const markup = renderToStaticMarkup(
			<CloudAccountAccess environmentId="env-cloud" />,
		);

		expect(markup).toContain("Developer access");
		expect(markup).toContain("Developer tools");
		expect(markup).toContain("Checking installed developer tools.");
		expect(markup).not.toContain(">Ready</span>");
		expect(markup).toContain("Private repository access");
		expect(markup).toContain("GitHub");
		expect(markup).toContain("Claude");
		expect(markup).toContain("Codex");
		expect(markup.match(/>Connect<\/button>/gu)).toHaveLength(3);
		expect(markup).toContain('aria-label="Refresh developer access"');
		expect(markup).toContain('aria-live="polite"');
		expect(markup).not.toContain('type="password"');
		expect(markup).not.toContain("auth.json");
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
});
