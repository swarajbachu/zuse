import { environmentRoute } from "@zuse/client-runtime/environment-scope";
import { describe, expect, it } from "vitest";
import {
	hostedLaptopPreferenceKey,
	resolveHostedLaptopPreference,
} from "../../src/lib/hosted-laptop-preferences.ts";

describe("optional hosted laptop access", () => {
	it("defaults to cloud for new and malformed browser preferences", () => {
		for (const raw of [null, "invalid", "null", "[]", '{"enabled":"true"}'])
			expect(resolveHostedLaptopPreference("/", raw)).toEqual({
				enabled: false,
				environmentId: null,
			});
	});
	it("remembers an explicit opt-in and selected computer", () => {
		expect(
			resolveHostedLaptopPreference(
				"/",
				JSON.stringify({ enabled: true, environmentId: "laptop-1" }),
			),
		).toEqual({ enabled: true, environmentId: "laptop-1" });
	});
	it("opens an explicit computer link even when the toggle was off", () => {
		expect(
			resolveHostedLaptopPreference(
				environmentRoute("laptop-2"),
				JSON.stringify({ enabled: false, environmentId: "laptop-1" }),
			),
		).toEqual({ enabled: true, environmentId: "laptop-2" });
	});
	it("isolates saved computer choices between accounts", () => {
		expect(hostedLaptopPreferenceKey("account-1")).not.toBe(
			hostedLaptopPreferenceKey("account-2"),
		);
	});
});
