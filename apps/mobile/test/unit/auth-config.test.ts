import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	defaultApiBaseUrl,
	defaultWorkosClientId,
} from "../../src/auth/config";

const require = createRequire(import.meta.url);
const baseExpoConfig = require("../../app.json").expo as Record<
	string,
	unknown
>;
const createExpoConfig = require("../../app.config.js") as (context: {
	readonly config: Record<string, unknown>;
}) => {
	readonly name: string;
	readonly scheme: string;
	readonly ios: {
		readonly bundleIdentifier: string;
		readonly entitlements: Readonly<Record<string, readonly string[]>>;
	};
	readonly extra: {
		readonly appVariant: string;
		readonly releaseChannel: string;
	};
};

describe("mobile api configuration", () => {
	it("keeps development on staging and release builds on production", () => {
		expect(defaultWorkosClientId(true)).toBe(
			"client_01KW6ZEZKVMZ0G429A89XZD83Q",
		);
		expect(defaultWorkosClientId(false)).toBe(
			"client_01KWGQ818571ARFATQ3G9AR2Y2",
		);
		expect(defaultApiBaseUrl(true)).toBe("https://api-staging.zuse.sh");
		expect(defaultApiBaseUrl(false)).toBe("https://api.zuse.sh");
	});

	it("pins each build profile to the intended identity and api", async () => {
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
		expect(eas.build.development?.env).toMatchObject({
			APP_VARIANT: "development",
			EXPO_PUBLIC_APP_SCHEME: "zuse-dev",
			EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_01KW6ZEZKVMZ0G429A89XZD83Q",
			EXPO_PUBLIC_ZUSE_API_URL: "https://api-staging.zuse.sh",
		});
		expect(eas.build.testflight?.env).toMatchObject({
			APP_VARIANT: "testflight",
			EXPO_PUBLIC_APP_SCHEME: "zuse",
			EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_01KW6ZEZKVMZ0G429A89XZD83Q",
			EXPO_PUBLIC_ZUSE_API_URL: "https://api-staging.zuse.sh",
		});
		expect(eas.build.production?.env).toMatchObject({
			APP_VARIANT: "production",
			EXPO_PUBLIC_APP_SCHEME: "zuse",
			EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_01KWGQ818571ARFATQ3G9AR2Y2",
			EXPO_PUBLIC_ZUSE_API_URL: "https://api.zuse.sh",
		});
	});

	it("gives local development a separate install identity", () => {
		const previousVariant = process.env.APP_VARIANT;
		try {
			process.env.APP_VARIANT = "development";
			const development = createExpoConfig({ config: baseExpoConfig });
			expect(development).toMatchObject({
				name: "Zuse Dev",
				scheme: "zuse-dev",
				ios: { bundleIdentifier: "com.zuse.sh.dev" },
				extra: {
					appVariant: "development",
					releaseChannel: "development",
				},
			});

			for (const variant of ["testflight", "production"]) {
				process.env.APP_VARIANT = variant;
				expect(createExpoConfig({ config: baseExpoConfig })).toMatchObject({
					name: "Zuse",
					scheme: "zuse",
					ios: { bundleIdentifier: "com.zuse.sh" },
					extra: { appVariant: variant, releaseChannel: variant },
				});
			}
		} finally {
			if (previousVariant === undefined) delete process.env.APP_VARIANT;
			else process.env.APP_VARIANT = previousVariant;
		}
	});

	it("keeps committed iOS settings aligned with Expo variants", async () => {
		const mobileRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../..",
		);
		const [project, infoPlist, debugEntitlements] = await Promise.all([
			readFile(
				resolve(mobileRoot, "ios/ZuseMobile.xcodeproj/project.pbxproj"),
				"utf8",
			),
			readFile(resolve(mobileRoot, "ios/ZuseMobile/Info.plist"), "utf8"),
			readFile(
				resolve(mobileRoot, "ios/ZuseMobile/ZuseMobile.debug.entitlements"),
				"utf8",
			),
		]);

		expect(project).toContain('APP_URL_SCHEME = "zuse-dev"');
		expect(project).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.zuse.sh.dev");
		expect(project).toContain('PRODUCT_NAME = "Zuse Dev"');
		expect(project).toContain("APP_URL_SCHEME = zuse");
		expect(project).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.zuse.sh");
		expect(infoPlist).toContain("$(APP_URL_SCHEME)");
		expect(infoPlist).toContain("$(PRODUCT_BUNDLE_IDENTIFIER)");
		expect(debugEntitlements).toContain(
			"$(AppIdentifierPrefix)com.zuse.sh.dev",
		);
	});
});
