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

		expect(dialogBody).not.toContain(
			"settings:cloud_workspace_auth_save_and_verify",
		);
		expect(dialogBody).not.toContain(
			"settings:cloud_workspace_auth_start_device_login",
		);
		expect(dialogBody).not.toContain(
			"settings:cloud_workspace_auth_open_authorization",
		);
		expect(dialogFooter).toContain(
			"settings:cloud_workspace_auth_save_and_verify",
		);
		expect(dialogFooter).toContain(
			"settings:cloud_workspace_auth_start_device_login",
		);
		expect(dialogFooter).toContain(
			"settings:cloud_workspace_auth_open_authorization",
		);
	});

	it("keeps every visible auth action at the compact cloud control height", () => {
		expect(authDialogSource).toContain(
			"const COMPACT_AUTH_ACTION = COMPACT_CLOUD_ACTION",
		);
		expect(authDialogSource).not.toMatch(/className={`w-full/);
	});
});
