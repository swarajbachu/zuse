import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApplicationBootstrap } from "../../src/application-bootstrap.tsx";

describe("application bootstrap", () => {
	it("mounts a bounded startup surface without suspending the root", () => {
		const markup = renderToStaticMarkup(<ApplicationBootstrap />);

		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain('aria-label="Loading Zuse"');
	});
});
