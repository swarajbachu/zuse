import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	defaultApiBaseUrl,
	defaultWorkosClientId,
} from "../../src/auth/config";

describe("mobile api configuration", () => {
	it("keeps development on staging and release builds on production", () => {
		expect(defaultWorkosClientId(true)).toBe(
			"client_01KW6ZEZKVMZ0G429A89XZD83Q",
		);
		expect(defaultWorkosClientId(false)).toBe(
			"client_01KWGQ818571ARFATQ3G9AR2Y2",
		);
		expect(defaultApiBaseUrl(true)).toBe("https://api-staging.stuff.md");
		expect(defaultApiBaseUrl(false)).toBe("https://api.zuse.sh");
	});

	it("pins internal builds to the staging identity and api", async () => {
		const eas = JSON.parse(
			await readFile(
				resolve(dirname(fileURLToPath(import.meta.url)), "../../eas.json"),
				"utf8",
			),
		) as {
			readonly build: Readonly<
				Record<string, { readonly env?: Readonly<Record<string, string>> }>
			>;
		};
		for (const profile of ["development", "preview"]) {
			expect(eas.build[profile]?.env).toMatchObject({
				EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_01KW6ZEZKVMZ0G429A89XZD83Q",
				EXPO_PUBLIC_ZUSE_API_URL: "https://api-staging.stuff.md",
			});
		}
		expect(eas.build.production?.env?.EXPO_PUBLIC_WORKOS_CLIENT_ID).toBe(
			"client_01KWGQ818571ARFATQ3G9AR2Y2",
		);
	});
});
