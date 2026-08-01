import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApplicationBootstrapFallback } from "../../src/application-bootstrap.tsx";

describe("application bootstrap", () => {
	it("reserves the full application viewport while the runtime loads", () => {
		const markup = renderToStaticMarkup(<ApplicationBootstrapFallback />);

		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain('aria-label="Loading Zuse"');
		expect(markup).toContain("h-dvh");
		expect(markup).toContain("w-screen");
	});
});
