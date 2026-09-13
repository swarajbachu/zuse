import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileSearchDialog } from "../../src/components/file-search.tsx";
import type { CommandPaletteGroup } from "../../src/components/ui/command-palette.tsx";

// Render the actual result icons without the modal's browser-only portal.
vi.mock("../../src/components/ui/command-palette.tsx", () => ({
	CommandPaletteDialog: ({
		groups,
	}: {
		groups: ReadonlyArray<CommandPaletteGroup<string>>;
	}) => (
		<div>
			{groups.flatMap((group) =>
				group.items.map((item) => <span key={item.id}>{item.icon}</span>),
			)}
		</div>
	),
}));

describe("file search result icons", () => {
	it.each([
		["README.md", "markdown"],
		["src/app.tsx", "react"],
		["src/index.ts", "typescript"],
		["Dockerfile", "docker"],
	] as const)("renders the shared file-type icon for %s", (path, token) => {
		const markup = renderToStaticMarkup(
			<FileSearchDialog
				files={[path]}
				onClose={() => {}}
				onSelect={() => {}}
			/>,
		);
		expect(markup).toContain(`data-file-icon-token="${token}"`);
		expect(markup).toContain('aria-hidden="true"');
	});
});
