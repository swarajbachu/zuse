import { activateLocale, prepareLocale } from "@zuse/i18n";
import { afterEach, describe, expect, it } from "vitest";
import {
	cloudProviderLabel,
	cloudProviderSizeLabel,
} from "../../src/lib/cloud-provider-presentation.ts";

afterEach(async () => {
	await activateLocale("en");
});

describe("cloud provider size presentation", () => {
	it("shows Boat for the retained Box provider ID", () => {
		expect(cloudProviderLabel("box")).toBe("Boat");
		expect(cloudProviderLabel("e2b")).toBe("E2B");
	});
	const size = {
		sizeId: "small",
		displayName: "Small",
		vcpuCount: 2,
		memoryMib: 4096,
	};

	it("updates labels after switching languages and uses the advertised resources", async () => {
		await prepareLocale("fr", ["chat"]);
		await activateLocale("fr");
		expect(cloudProviderSizeLabel("box", size)).toBe("Petite (2 vCPU / 4 Go)");
		await prepareLocale("ja", ["chat"]);
		await activateLocale("ja");
		expect(cloudProviderSizeLabel("box", { ...size, memoryMib: 8192 })).toBe(
			"小（2 vCPU / 8 GB）",
		);
		await activateLocale("en");
		expect(cloudProviderSizeLabel("box", size)).toBe("Small (2 vCPU / 4 GB)");
	});

	it("preserves provider-defined names for unknown providers and sizes", async () => {
		await prepareLocale("fr", ["chat"]);
		await activateLocale("fr");
		expect(cloudProviderSizeLabel("e2b", size)).toBe("Small");
		expect(
			cloudProviderSizeLabel("box", {
				...size,
				sizeId: "custom",
				displayName: "GPU XL",
			}),
		).toBe("GPU XL");
	});
});
