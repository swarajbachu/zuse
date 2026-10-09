import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	CloudWorkspaceAuth,
	CodexDeviceLoginInstructions,
} from "../../src/components/settings/cloud-workspace-auth.tsx";

describe("CloudWorkspaceAuth", () => {
	it("keeps every provider and its direct action visible while status loads", () => {
		const markup = renderToStaticMarkup(<CloudWorkspaceAuth />);

		expect(markup).toContain("Zuse agent accounts");
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).toContain("Cursor");
		expect(markup).toContain("Grok");
		expect(markup).toContain("Connect");
		// The explanation lives in the header's help tooltip, not inline.
		expect(markup).not.toContain("Connect each agent once");
		expect(markup).toContain('aria-label="Zuse agent accounts"');
		expect(markup).not.toContain("E2B");
		expect(markup.replace(/<[^>]+>/g, "")).not.toContain("Box");
		expect(markup).not.toContain("Create in E2B");
		expect(markup).not.toContain("Setup required");
	});

	it("only offers snapshot-supported accounts when scoped to Claude Code and Codex", () => {
		const markup = renderToStaticMarkup(
			<CloudWorkspaceAuth providers={["claude", "codex"]} />,
		);
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).not.toContain("Cursor");
		expect(markup).not.toContain("Grok");
	});

	it("renders only provider rows when embedded in a caller's group", () => {
		const markup = renderToStaticMarkup(
			<CloudWorkspaceAuth providers={["claude", "codex"]} embedded />,
		);
		expect(markup).not.toContain("Zuse agent accounts");
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).toContain("Connect");
	});

	it("explains every official Codex device-login step", () => {
		const markup = renderToStaticMarkup(<CodexDeviceLoginInstructions />);

		expect(markup).toContain("Settings → Security");
		expect(markup).toContain("codex login --device-auth");
		expect(markup).toContain("15 minutes");
		expect(markup).toContain("Only approve a login you started here");
	});
});
