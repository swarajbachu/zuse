import { describe, expect, it } from "vitest";

import { resumeAfterProviderLogin } from "../../src/lib/provider-auth-recovery.ts";
import { supportsProviderLogin } from "../../src/lib/use-provider-login.ts";
import { classifyMessage } from "../../src/store/messages.ts";

describe("provider inline login", () => {
	it("supports only providers with a server-side login handler", () => {
		expect(supportsProviderLogin("claude")).toBe(true);
		expect(supportsProviderLogin("cursor")).toBe(false);
		expect(supportsProviderLogin("grok")).toBe(true);
		expect(supportsProviderLogin("codex")).toBe(false);
		expect(supportsProviderLogin("gemini")).toBe(false);
		expect(supportsProviderLogin("opencode")).toBe(false);
	});

	it("classifies the Grok session-start message as authentication", () => {
		expect(
			classifyMessage(
				"Authentication required. Sign in to Grok to continue.",
				"grok",
			),
		).toEqual({
			kind: "auth",
			providerId: "grok",
			message: "Authentication required. Sign in to Grok to continue.",
		});
	});

	it("does not classify entitlement failures as authentication", () => {
		expect(
			classifyMessage("This account does not include Grok Build.", "grok"),
		).toEqual({
			kind: "generic",
			message: "This account does not include Grok Build.",
		});
	});

	it("reopens before retrying a blocked existing-chat turn", async () => {
		const calls: string[] = [];
		await expect(
			resumeAfterProviderLogin({
				reopen: async () => {
					calls.push("reopen");
					return true;
				},
				retry: async () => {
					calls.push("retry");
					return true;
				},
				resumeQueue: async () => {
					calls.push("queue");
				},
			}),
		).resolves.toBe(true);
		expect(calls).toEqual(["reopen", "retry"]);
	});

	it("flushes a fresh chat's startup queue when there is no sent turn", async () => {
		const calls: string[] = [];
		await expect(
			resumeAfterProviderLogin({
				reopen: async () => {
					calls.push("reopen");
					return true;
				},
				retry: async () => {
					calls.push("retry");
					return false;
				},
				resumeQueue: async () => {
					calls.push("queue");
				},
			}),
		).resolves.toBe(true);
		expect(calls).toEqual(["reopen", "retry", "queue"]);
	});
});
