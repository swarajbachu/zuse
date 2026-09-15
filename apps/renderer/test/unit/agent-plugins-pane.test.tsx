import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ desktop: true, environment: "local" }));
vi.mock("../../src/lib/agent-plugin-client.ts", () => ({
	agentPluginActions: { catalog: vi.fn(), inspect: vi.fn(), execute: vi.fn() },
}));
vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	rendererPlatformCapabilities: () => ({ desktop: state.desktop }),
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local",
}));
vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: (
		select: (s: { activeEnvironmentId: string }) => unknown,
	) => select({ activeEnvironmentId: state.environment }),
}));

import { AgentPluginsPane } from "../../src/components/settings/agent-plugins-pane.tsx";

beforeEach(() => {
	state.desktop = true;
	state.environment = "local";
});
it("keeps plugin management separate from extensions with compact existing controls", () => {
	const html = renderToStaticMarkup(<AgentPluginsPane />);
	expect(html).toContain("Codex plugins run inside Codex");
	expect(html).toContain("Search Codex plugins");
	expect(html).toContain("h-7");
	expect(html).not.toContain("No matching plugins");
});
it("does not expose native management controls on web or a remote environment", () => {
	for (const remote of [false, true]) {
		state.desktop = remote;
		state.environment = remote ? "remote" : "local";
		const html = renderToStaticMarkup(<AgentPluginsPane />);
		expect(html).toContain("local desktop");
		expect(html).not.toContain("<input");
	}
});
