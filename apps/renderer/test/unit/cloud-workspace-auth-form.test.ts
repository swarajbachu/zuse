import { describe, expect, it } from "vitest";
import authDialogSource from "../../src/components/settings/cloud-workspace-auth.tsx?raw";

describe("cloud workspace auth form structure", () => {
	it("keeps the panel and footer inside one semantic form", () => {
		const formStart = authDialogSource.indexOf(
			'<form className="contents" onSubmit={submitProviderSetup}>',
		);
		const panelStart = authDialogSource.indexOf("<DialogPanel", formStart);
		const footerStart = authDialogSource.indexOf("<DialogFooter>", panelStart);
		const formEnd = authDialogSource.indexOf("</form>", footerStart);

		expect(formStart).toBeGreaterThan(-1);
		expect(panelStart).toBeGreaterThan(formStart);
		expect(footerStart).toBeGreaterThan(panelStart);
		expect(formEnd).toBeGreaterThan(footerStart);
	});

	it("uses dialog close for cancellation and submit actions for credentials", () => {
		expect(authDialogSource).toContain("<DialogClose");
		expect(authDialogSource.match(/type="submit"/gu)).toHaveLength(2);
		expect(authDialogSource).toContain("if (canConfigure) void configure()");
		expect(authDialogSource).toContain(
			'if (operation?.state !== "authorizing") void startLogin()',
		);
	});

	it("labels every credential field instead of relying on placeholders", () => {
		for (const id of [
			"cloud-auth-token",
			"cloud-auth-api-key",
			"cloud-auth-base-url",
			"cloud-auth-provider-name",
			"cloud-auth-secret",
		]) {
			expect(authDialogSource).toContain(`htmlFor="${id}"`);
			expect(authDialogSource).toContain(`id="${id}"`);
		}
	});
});
