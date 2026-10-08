import { describe, expect, test } from "vitest";
import {
	availableSandboxProviders,
	boxdBillingConfigured,
} from "../../src/sandbox-provider-availability.ts";

const providers = [
	{ providerId: "box", advertised: true, productionReady: true },
	{ providerId: "e2b", advertised: true, productionReady: true },
	{ providerId: "boxd", advertised: true, productionReady: true },
	{ providerId: "experimental", advertised: true, productionReady: false },
	{ providerId: "hidden", advertised: false, productionReady: true },
];

describe("sandbox placement availability", () => {
	test("requires an explicit valid boxd cutover before paid placement", () => {
		expect(boxdBillingConfigured("true", "2026-10-06T00:00:00Z")).toBe(true);
		for (const cutover of [undefined, "invalid", "2026-10-06T00:00:00.001Z"])
			expect(boxdBillingConfigured("true", cutover)).toBe(false);
		expect(boxdBillingConfigured("false", "2026-10-06T00:00:00Z")).toBe(false);
	});
	test("allows billing-enforced boxd only with completed-cost opt-in", () => {
		expect([
			...availableSandboxProviders(providers, false, true, true),
		]).toEqual(["box", "e2b", "boxd"]);
	});
	test.each([
		false,
		true,
	])("excludes unbillable boxd when billing is enforced (sandbox=%s)", (sandbox) => {
		expect([...availableSandboxProviders(providers, sandbox, true)]).toEqual(
			sandbox ? ["box", "e2b", "experimental"] : ["box", "e2b"],
		);
	});
	test.each([
		false,
		true,
	])("allows boxd without billing enforcement (sandbox=%s)", (sandbox) => {
		expect([...availableSandboxProviders(providers, sandbox, false)]).toEqual(
			sandbox ? ["box", "e2b", "boxd", "experimental"] : ["box", "e2b", "boxd"],
		);
	});
});
