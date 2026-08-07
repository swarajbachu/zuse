import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CloudGithubAccessShortcutButton } from "../../src/components/top-bar.tsx";

describe("CloudGithubAccessShortcutButton", () => {
	it("exposes the cloud GitHub setup flow as a labelled button", () => {
		const markup = renderToStaticMarkup(
			<CloudGithubAccessShortcutButton onClick={() => undefined} />,
		);

		expect(markup).toContain(">Connect GitHub</button>");
		expect(markup).toContain(
			'aria-label="Connect GitHub to this cloud machine"',
		);
	});
});
