import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CloudAccountAccess } from "../../src/components/settings/cloud-account-access.tsx";

describe("CloudAccountAccess", () => {
	it("renders a stable keyboard-operable setup checklist without secret inputs", () => {
		const markup = renderToStaticMarkup(<CloudAccountAccess />);

		expect(markup).toContain("Bring access from this Mac");
		expect(markup).toContain("Developer tools");
		expect(markup).toContain("Project access");
		expect(markup).toContain("GitHub");
		expect(markup).toContain("Claude");
		expect(markup).toContain("Codex");
		expect(markup.match(/>Connect<\/button>/gu)).toHaveLength(3);
		expect(markup).toContain('aria-live="polite"');
		expect(markup).not.toContain('type="password"');
		expect(markup).not.toContain("auth.json");
	});
});
