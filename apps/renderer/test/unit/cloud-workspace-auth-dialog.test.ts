import { describe, expect, it } from "vitest";
import authDialogSource from "../../src/components/settings/cloud-workspace-auth.tsx?raw";

describe("cloud workspace authentication dialog", () => {
	it("keeps provider actions in the shared dialog footer", () => {
		const panelEnd = authDialogSource.indexOf("</DialogPanel>");
		const footerStart = authDialogSource.indexOf("<DialogFooter>");
		const footerEnd = authDialogSource.indexOf("</DialogFooter>");

		expect(panelEnd).toBeGreaterThan(-1);
		expect(footerStart).toBeGreaterThan(panelEnd);
		expect(footerEnd).toBeGreaterThan(footerStart);

		const dialogBody = authDialogSource.slice(0, panelEnd);
		const dialogFooter = authDialogSource.slice(footerStart, footerEnd);

		expect(dialogBody).not.toContain("Save and verify");
		expect(dialogBody).not.toContain("Start device login");
		expect(dialogBody).not.toContain("Open authorization");
		expect(dialogFooter).toContain("Save and verify");
		expect(dialogFooter).toContain("Start device login");
		expect(dialogFooter).toContain("Open authorization");
	});

	it("keeps every visible auth action at the compact cloud control height", () => {
		expect(authDialogSource).toContain(
			"const COMPACT_AUTH_ACTION = COMPACT_CLOUD_ACTION",
		);
		expect(authDialogSource).not.toMatch(/className={`w-full/);
	});
});
