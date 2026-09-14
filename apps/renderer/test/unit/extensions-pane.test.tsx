import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../../src/lib/extension-client-bus.ts", () => ({
	extensionActions: { marketplace: vi.fn(async () => []) },
	useExtensionCatalog: () => ({ globallyEnabled: false, items: [] }),
}));
vi.mock("../../src/lib/extension-registry.tsx", () => ({
	useExtensionContributions: () => [],
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	useSettingsStore: (select: (state: unknown) => unknown) =>
		select({
			themeSelection: { _tag: "builtin" },
			setThemeSelection: () => {},
		}),
}));
vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	openExternal: vi.fn(),
}));

import { ExtensionsPane } from "../../src/components/settings/extensions-pane.tsx";

it("shows three honest source-install previews while the catalog is loading", () => {
	const html = renderToStaticMarkup(<ExtensionsPane />);
	for (const name of ["Test Reports", "Project Playbook", "Code Follow-ups"])
		expect(html).toContain(name);
	expect(html).toContain("Source installation is also available for development.");
	expect(html.match(/Source &amp; setup/g)).toHaveLength(3);
	expect(html).toContain("Loading marketplace");
	expect(html).not.toContain("No signed marketplace entries");
	expect(html).not.toContain('role="alert"');
});
