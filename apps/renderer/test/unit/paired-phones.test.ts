import type { AuthTokenId, AuthTokenSummary } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import {
	accessDeviceKind,
	deviceAccessCopy,
	groupPairedDeviceTokens,
} from "../../src/lib/paired-phones.ts";

const token = (
	id: string,
	input: Partial<AuthTokenSummary> = {},
): AuthTokenSummary => ({
	id: id as AuthTokenId,
	label: "Phone",
	createdAt: new Date("2026-07-18T00:00:00.000Z"),
	...input,
});

describe("paired phone presentation", () => {
	test("shows identified phones individually and consolidates active legacy access", () => {
		const result = groupPairedDeviceTokens([
			token("auth_phone", { deviceId: "mobile_1" }),
			token("auth_browser", { deviceId: "browser_1", label: "Browser" }),
			token("auth_legacy_1"),
			token("auth_legacy_2"),
			token("auth_revoked", { revokedAt: new Date() }),
		]);

		expect(result.identifiedDevices.map((item) => item.id)).toEqual([
			"auth_phone",
			"auth_browser",
		]);
		expect(result.legacyCredentials.map((item) => item.id)).toEqual([
			"auth_legacy_1",
			"auth_legacy_2",
		]);
	});

	test("distinguishes browser sessions from mobile devices", () => {
		expect(
			accessDeviceKind(
				token("auth_browser", { deviceId: "browser_1", label: "Browser" }),
			),
		).toBe("browser");
		expect(
			accessDeviceKind(token("auth_phone", { deviceId: "mobile_1" })),
		).toBe("mobile");
	});

	test("uses user-facing access concepts", () => {
		expect(deviceAccessCopy).toEqual({
			localTitle: "Browser and device access",
			pairedTitle: "Connected devices",
			remoteTitle: "Remote access",
		});
	});
});
