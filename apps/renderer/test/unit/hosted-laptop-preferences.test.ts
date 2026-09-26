import { environmentRoute } from "@zuse/client-runtime/environment-scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hostedLaptopPreferenceKey,
	resolveHostedLaptopPreference,
	saveHostedLaptopPreference,
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

afterEach(() => vi.unstubAllGlobals());
it("shares the settings computer selection with the sidebar without changing other accounts", () => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		setItem: (key: string, value: string) => values.set(key, value),
	});
	saveHostedLaptopPreference("account-a", {
		enabled: true,
		environmentId: "laptop-a",
	});
	saveHostedLaptopPreference("account-b", {
		enabled: false,
		environmentId: "laptop-b",
	});
	expect(
		resolveHostedLaptopPreference(
			"/",
			values.get(hostedLaptopPreferenceKey("account-a")) ?? null,
		),
	).toEqual({ enabled: true, environmentId: "laptop-a" });
	expect(
		resolveHostedLaptopPreference(
			"/",
			values.get(hostedLaptopPreferenceKey("account-b")) ?? null,
		),
	).toEqual({ enabled: false, environmentId: "laptop-b" });
});
