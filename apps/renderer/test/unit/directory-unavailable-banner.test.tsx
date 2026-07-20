import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DirectoryUnavailableBanner } from "../../src/components/directory-unavailable-banner.tsx";

describe("DirectoryUnavailableBanner", () => {
	it("uses the exact active-chat copy", () => {
		expect(renderToStaticMarkup(<DirectoryUnavailableBanner />)).toContain(
			"This directory has been deleted and it&#x27;s inaccessible.",
		);
	});

	it("uses the exact archived-chat copy", () => {
		expect(
			renderToStaticMarkup(<DirectoryUnavailableBanner archived />),
		).toContain("This directory is unavailable.");
	});
});
