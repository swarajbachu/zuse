import type { Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	latestProviderAuthFailureAt,
	resumeAfterProviderLogin,
} from "../../src/lib/provider-auth-recovery.ts";
import { classifyMessage } from "../../src/lib/session-actions.ts";
import { supportsProviderLogin } from "../../src/lib/use-provider-login.ts";

describe("provider inline login", () => {
	it("supports only providers with a server-side login handler", () => {
		expect(supportsProviderLogin("claude")).toBe(true);
		expect(supportsProviderLogin("cursor")).toBe(false);
		expect(supportsProviderLogin("grok")).toBe(true);
		expect(supportsProviderLogin("codex")).toBe(false);
		expect(supportsProviderLogin("gemini")).toBe(false);
		expect(supportsProviderLogin("opencode")).toBe(false);
		expect(supportsProviderLogin("opencode2")).toBe(false);
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

	it("reopens the durable turn before releasing queued work", async () => {
		const calls: string[] = [];
		await expect(
			resumeAfterProviderLogin({
				reopen: async () => {
					calls.push("reopen");
					return true;
				},
				resumeQueue: async () => {
					calls.push("queue");
				},
			}),
		).resolves.toBe(true);
		expect(calls).toEqual(["reopen", "queue"]);
	});

	it("flushes a fresh chat's startup queue when there is no sent turn", async () => {
		const calls: string[] = [];
		await expect(
			resumeAfterProviderLogin({
				reopen: async () => {
					calls.push("reopen");
					return true;
				},
				resumeQueue: async () => {
					calls.push("queue");
				},
			}),
		).resolves.toBe(true);
		expect(calls).toEqual(["reopen", "queue"]);
	});

	it("classifies an expired Claude OAuth session as authentication", () => {
		const text =
			"Failed to authenticate: OAuth session expired and could not be refreshed";
		expect(classifyMessage(text, "claude")).toEqual({
			kind: "auth",
			providerId: "claude",
			message: text,
		});
	});

	it("tracks a sign-in failure only while it ends the transcript", () => {
		const message = (
			id: string,
			content: Message["content"],
			createdAt: string,
		): Message =>
			({
				id,
				sessionId: "session-provider-login" as SessionId,
				role: "assistant",
				content,
				createdAt: new Date(createdAt),
			}) as Message;
		const user = message(
			"user",
			{ _tag: "user", text: "hi" } as Message["content"],
			"2026-01-01T00:00:00Z",
		);
		const failed = message(
			"failed",
			{ _tag: "error", message: "Not logged in · Please run /login" },
			"2026-01-01T00:00:01Z",
		);
		const usage = message(
			"usage",
			{ _tag: "usage" } as Message["content"],
			"2026-01-01T00:00:02Z",
		);
		const retry = message(
			"retry",
			{ _tag: "user", text: "again" } as Message["content"],
			"2026-01-01T00:00:03Z",
		);
		const other = message(
			"other",
			{ _tag: "error", message: "Something broke" },
			"2026-01-01T00:00:04Z",
		);

		expect(latestProviderAuthFailureAt([user, failed, usage])).toEqual(
			failed.createdAt,
		);
		expect(latestProviderAuthFailureAt([user, failed, retry])).toBeNull();
		expect(latestProviderAuthFailureAt([user, failed, other])).toBeNull();
		expect(latestProviderAuthFailureAt([])).toBeNull();
	});
});
