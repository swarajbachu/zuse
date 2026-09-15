import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { GitHubAvatar } from "../../src/components/github-avatar.tsx";

test("an app avatar has a visible initial before its image has loaded", () => {
	const markup = renderToStaticMarkup(
		<GitHubAvatar
			name="greptile-apps[bot]"
			url="https://avatars.githubusercontent.com/in/867647?v=4"
		/>,
	);
	expect(markup).toContain('data-slot="avatar-fallback"');
	expect(markup).toContain(">G</span>");
	expect(markup).toContain("rounded-[25%]");
	expect(markup).not.toContain("rounded-full");
});
test("missing app artwork keeps an accessible fallback without guessing a profile URL", () => {
	const markup = renderToStaticMarkup(
		<GitHubAvatar name="greptile-apps[bot]" />,
	);
	expect(markup).toContain('aria-label="greptile-apps[bot]"');
	expect(markup).toContain(">G</span>");
	expect(markup).not.toContain("github.com/greptile");
});
