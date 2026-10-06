import { describe, expect, it } from "vitest";
import { settingsNavigationFor } from "../../src/lib/settings-navigation.ts";

describe("settings contexts", () => {
	it("keeps the Help diagnostics destination available inside an organization", () => {
		const navigation = settingsNavigationFor({ kind: "diagnostics" }, true, {
			kind: "organization",
			organizationId: "org_a",
		});
		expect(navigation.some((item) => item.section.kind === "diagnostics")).toBe(
			true,
		);
	});
	it("reuses regular settings in organizations without a separate sharing page", () => {
		const organization = settingsNavigationFor(
			{ kind: "organizations" },
			true,
			{ kind: "organization", organizationId: "org_a" },
		);
		const ids = organization.map((item) => item.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"general",
				"defaults",
				"browser",
				"shortcuts",
				"organizations",
				"billing",
			]),
		);
		expect(ids).not.toContain("sharing");
		expect(new Set(ids).size).toBe(ids.length);
		expect(
			settingsNavigationFor({ kind: "general" }, false, {
				kind: "organization",
				organizationId: "org_a",
			}).map((item) => item.id),
		).not.toContain("self-hosted");
		expect(
			settingsNavigationFor({ kind: "general" }, true, {
				kind: "personal",
			}).some((item) => item.id === "sharing"),
		).toBe(false);
	});
	for (const desktop of [true, false]) {
		it(`keeps organization features out of personal settings (${desktop ? "desktop" : "web"})`, () => {
			const personal = settingsNavigationFor({ kind: "general" }, desktop).map(
				(item) => item.id,
			);
			expect(personal).toContain("general");
			expect(personal).not.toContain("organizations");
			if (!desktop) {
				expect(personal).not.toContain("self-hosted");
				expect(personal).not.toContain("machines");
			}
		});
	}
});
