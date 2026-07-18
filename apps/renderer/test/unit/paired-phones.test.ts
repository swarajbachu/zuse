import type { AuthTokenId, AuthTokenSummary } from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import {
	deviceAccessCopy,
	groupPairedPhoneTokens,
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
		const result = groupPairedPhoneTokens([
			token("auth_phone", { deviceId: "mobile_1" }),
			token("auth_legacy_1"),
			token("auth_legacy_2"),
			token("auth_revoked", { revokedAt: new Date() }),
		]);

		expect(result.identifiedPhones.map((item) => item.id)).toEqual([
			"auth_phone",
		]);
		expect(result.legacyCredentials.map((item) => item.id)).toEqual([
			"auth_legacy_1",
			"auth_legacy_2",
		]);
	});

	test("uses user-facing access concepts", () => {
		expect(deviceAccessCopy).toEqual({
			localTitle: "Local access",
			pairedTitle: "Paired phones",
			remoteTitle: "Remote access",
		});
	});
});
