import { describe, expect, it } from "vitest";

import {
	cloudFailurePresentation,
	cloudInteractionFailure,
} from "../../src/lib/cloud-failure-presentation.ts";

describe("cloud failure presentation", () => {
	it("uses storage-loss copy only for storage replacement outcomes", () => {
		expect(
			cloudFailurePresentation({
				state: "outcome-unknown",
				category: "runtime-storage-replaced",
			}),
		).toMatchObject({
			kind: "outcome-unknown",
			headline: "Command outcome unknown",
			message: expect.stringContaining("storage was replaced"),
		});
		expect(
			cloudFailurePresentation({
				state: "outcome-unknown",
				category: "runtime-receipt-missing",
			}),
		).toMatchObject({
			kind: "outcome-unknown",
			message: expect.stringContaining("not sent again"),
		});
		expect(
			cloudFailurePresentation({
				state: "outcome-unknown",
				category: "runtime-receipt-missing",
			})?.message,
		).not.toContain("storage was replaced");
	});

	it.each([
		[
			{ category: "sign-in-required", blockedUntil: "auth-restored" },
			"sign-in-required",
			"Sign in required",
		],
		[
			{ category: "billing-blocked", blockedUntil: "billing-restored" },
			"billing-blocked",
			"Billing action required",
		],
		[
			{ category: "update-required", blockedUntil: "runtime-compatible" },
			"update-required",
			"Update required",
		],
		[
			{ state: "cancelled", category: "workspace-deleted" },
			"workspace-deleted",
			"Workspace unavailable",
		],
		[
			{ state: "expired", category: "interaction-expired" },
			"interaction-expired",
			"Interaction expired",
		],
	] as const)("classifies %j as %s", (input, kind, headline) => {
		expect(cloudFailurePresentation(input)).toMatchObject({ kind, headline });
	});

	it("maps provider authentication and session errors without exposing raw tags", () => {
		expect(
			cloudFailurePresentation({
				cause: new Error(
					"Codex app-server failed: Auth(AuthorizationRequired)",
				),
			}),
		).toMatchObject({
			kind: "sign-in-required",
			headline: "Sign in required",
		});
		const missing = cloudFailurePresentation({
			cause: { _tag: "SessionNotFoundError", sessionId: "session-1" },
		});
		expect(missing).toMatchObject({
			kind: "session-unavailable",
			headline: "Session unavailable",
		});
		expect(missing?.message).not.toContain("SessionNotFoundError");
	});

	it.each([
		["codex-auth-reconnect-required", "sign-in-required"],
		["codex-auth-legacy-workspace", "sign-in-required"],
		["codex-auth-update-required", "update-required"],
		["codex-auth-reconnecting", "network"],
	] as const)("maps broker status %s to %s", (cause, kind) => {
		expect(cloudFailurePresentation({ cause })).toMatchObject({ kind });
	});

	it("recognizes a consumed Codex refresh token as account authentication", () => {
		expect(
			cloudFailurePresentation({
				cause: "refresh token was already used",
			}),
		).toMatchObject({ kind: "sign-in-required" });
	});

	it("presents a cached response to a missing session as an expired interaction", () => {
		expect(
			cloudInteractionFailure({
				_tag: "SessionNotFoundError",
				sessionId: "session-1",
			}),
		).toMatchObject({
			expired: true,
			presentation: {
				kind: "interaction-expired",
				headline: "Interaction expired",
			},
		});
	});
});
