import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	CloudWorkspaceAuth,
	CodexDeviceLoginInstructions,
} from "../../src/components/settings/cloud-workspace-auth.tsx";

describe("CloudWorkspaceAuth", () => {
	it("keeps every provider and its direct action visible while status loads", () => {
		const markup = renderToStaticMarkup(<CloudWorkspaceAuth />);

		expect(markup).toContain("Agent authentication");
		expect(markup).toContain("Claude Code");
		expect(markup).toContain("Codex");
		expect(markup).toContain("Cursor");
		expect(markup).toContain("Grok");
		expect(markup).toContain("Connect");
		expect(markup).toContain("Connect each agent once");
		expect(markup).not.toContain("E2B");
		expect(markup.replace(/<[^>]+>/g, "")).not.toContain("Box");
		expect(markup).not.toContain("Create in E2B");
		expect(markup).not.toContain("Setup required");
	});

	it("explains every official Codex device-login step", () => {
		const markup = renderToStaticMarkup(<CodexDeviceLoginInstructions />);

		expect(markup).toContain("Settings → Security");
		expect(markup).toContain("codex login --device-auth");
		expect(markup).toContain("15 minutes");
		expect(markup).toContain("Only approve a login you started here");
	});
});
