import { EnvironmentId, FolderId, GitPrCheckRun } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { GitStackMenu } from "../../src/components/git-stack-menu.tsx";
import { PrChecksPreview } from "../../src/components/pr-checks-preview.tsx";

test.each([
	"summary",
	"submenu",
] as const)("hides unknown stacks in the %s surface", (variant) => {
	const html = renderToStaticMarkup(
		<GitStackMenu
			variant={variant}
			executionRef={{
				environmentId: EnvironmentId.make("local"),
				folderId: FolderId.make("repo"),
				worktreeId: null,
				rootPath: "/repo",
			}}
			branch="main"
		/>,
	);
	expect(html).toBe("");
});

test("cached checks stay visible while refreshing and failures precede successful jobs", () => {
	const check = (name: string, conclusion: "success" | "failure") =>
		GitPrCheckRun.make({
			name,
			conclusion,
			status: "completed",
			url: "https://github.com/acme/app/actions/runs/1",
		});
	const html = renderToStaticMarkup(
		<PrChecksPreview
			checks={[check("build", "success"), check("test", "failure")]}
			loading
		/>,
	);
	expect(html.indexOf('title="test"')).toBeLessThan(
		html.indexOf('title="build"'),
	);
	expect(html).toContain('aria-label="test: failure"');
	expect(html).toContain('aria-label="build: success"');
	expect(html).not.toContain("Loading checks");
});
