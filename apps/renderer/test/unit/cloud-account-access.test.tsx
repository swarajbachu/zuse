import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	CloudAccountAccess,
	claudeAuthorizationFailureMessage,
	hasConnectedClaudeAccess,
} from "../../src/components/settings/cloud-account-access.tsx";
import {
	runtimePhaseLabel,
	runtimeVersionDescription,
} from "../../src/components/settings/cloud-machines-pane.tsx";

describe("CloudAccountAccess", () => {
	it("gives actionable Claude authorization failures", () => {
		expect(
			claudeAuthorizationFailureMessage(new Error("invalid-code")),
		).toContain("including the part after #");
		expect(
			claudeAuthorizationFailureMessage(new Error("token-not-captured")),
		).toContain("could not capture the credential");
	});

	it("reconciles a lost import response from the remote provider status", () => {
		expect(
			hasConnectedClaudeAccess({
				providers: [
					{
						providerId: "claude",
						state: "connected",
						installed: true,
						authKind: "oauth-token",
					},
				],
			}),
		).toBe(true);
		expect(hasConnectedClaudeAccess({ providers: [] })).toBe(false);
	});

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
		expect(
			markup.match(/<button[^>]*disabled=""[^>]*>Connect<\/button>/gu),
		).toHaveLength(3);
		expect(markup).not.toContain("Not connected");
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
