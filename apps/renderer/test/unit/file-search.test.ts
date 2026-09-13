import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import { EnvironmentId, FolderId, WorktreeId } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APPLICATION_COMMANDS,
	dispatchCommand,
} from "../../src/lib/commands.ts";
import { DEFAULT_KEYBINDINGS } from "../../src/lib/default-keybindings.ts";
import {
	fileSearchFeedback,
	fileSearchResults,
	searchableFiles,
	searchedFileTarget,
} from "../../src/lib/file-search.ts";
import { useUiStore } from "../../src/store/ui.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	useUiStore.getState().setFileSearchOpen(false);
});

describe("project file search", () => {
	it.each([
		"failed",
		"offline",
		"revoked",
		"blocked-auth",
		"update-required",
	] as const)("does not show a perpetual loading state for %s connections", (connection) => {
		expect(
			fileSearchFeedback(emptyResourceView(connection)).emptyMessage,
		).toContain("unavailable");
	});
	it("distinguishes loading, cached disconnection, and partial results", () => {
		const view = emptyResourceView<{ truncated: boolean }>("connecting");
		expect(fileSearchFeedback(view).emptyMessage).toContain("Loading");
		expect(
			fileSearchFeedback({
				...view,
				connection: "offline",
				data: { truncated: false },
			}).notice,
		).toContain("cached");
		expect(
			fileSearchFeedback({
				...view,
				connection: "connected",
				sync: "live",
				data: { truncated: true },
			}).notice,
		).toContain("partial");
	});
	it("keeps only one search modal open when switching with shortcuts", () => {
		const ui = useUiStore.getState();
		ui.setChatSwitcherOpen(true);
		ui.setFileSearchOpen(true);
		expect(useUiStore.getState()).toMatchObject({
			fileSearchOpen: true,
			chatSwitcherOpen: false,
		});
		ui.toggleChatSwitcher();
		expect(useUiStore.getState()).toMatchObject({
			fileSearchOpen: false,
			chatSwitcherOpen: true,
		});
		ui.setChatSwitcherOpen(false);
	});
	it("excludes directories and sorts without mutating the resource snapshot", () => {
		const paths = ["src/", "src/z.ts", "README.md", "src/a.ts"];
		expect(searchableFiles(paths)).toEqual([
			"README.md",
			"src/a.ts",
			"src/z.ts",
		]);
		expect(paths).toEqual(["src/", "src/z.ts", "README.md", "src/a.ts"]);
	});
	it("bounds empty and matching results, but can find a file outside the initial window", () => {
		const files = Array.from(
			{ length: 500 },
			(_, index) => `src/component-${index}.tsx`,
		);
		files.push("src/deep/unique-target.ts");
		expect(fileSearchResults(files, " ")).toHaveLength(100);
		expect(fileSearchResults(files, "component")).toHaveLength(100);
		expect(fileSearchResults(files, "unique-target")).toEqual([
			"src/deep/unique-target.ts",
		]);
		expect(fileSearchResults(files, "zzzzzzzz")).toEqual([]);
	});
	it("keeps cloud checkout, logical project, and worktree identity when opening", () => {
		const ref = {
			environmentId: EnvironmentId.make("cloud-1"),
			folderId: FolderId.make("checkout-1"),
			worktreeId: WorktreeId.make("worktree-1"),
			rootPath: "/worktree",
		};
		expect(
			searchedFileTarget(ref, FolderId.make("local-project"), "src/index.ts"),
		).toEqual({
			kind: "text",
			environmentId: ref.environmentId,
			folderId: ref.folderId,
			projectId: "local-project",
			worktreeId: ref.worktreeId,
			path: "src/index.ts",
			name: "index.ts",
		});
	});
	it("uses the shared shortcut registry and opens on dispatch without a mounted file tree", () => {
		expect(APPLICATION_COMMANDS.has("search-files")).toBe(true);
		expect(DEFAULT_KEYBINDINGS).toContainEqual({
			key: "mod+p",
			command: "search-files",
		});
		vi.stubGlobal("document", { body: { dataset: {} } });
		dispatchCommand("search-files");
		expect(useUiStore.getState().fileSearchOpen).toBe(true);
		useUiStore.getState().setFileSearchOpen(false);
		expect(useUiStore.getState().fileSearchOpen).toBe(false);
	});
});
