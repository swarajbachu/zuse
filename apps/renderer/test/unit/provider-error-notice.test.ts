import type { EnvironmentId, Message, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	describeProviderError,
	isBlockingNotice,
	parseRateLimit,
	parseReconnectingStatus,
} from "../../src/lib/provider-error-notice.ts";
import { latestTranscriptError } from "../../src/lib/session-actions.ts";

const local = "local" as EnvironmentId;

describe("provider error notices", () => {
	it("parses usage limits with their reset time or period", () => {
		expect(
			parseRateLimit("You've hit your limit · resets 3pm (Europe/London)"),
		).toEqual({ resetText: "3pm (Europe/London)", period: undefined });
		expect(parseRateLimit("Weekly usage limit reached")).toEqual({
			resetText: undefined,
			period: "weekly",
		});
		expect(parseRateLimit("Something broke")).toBeNull();
	});

	it("parses reconnect attempts", () => {
		expect(parseReconnectingStatus("Reconnecting... 2/5")).toEqual({
			attempt: 2,
			maxAttempts: 5,
		});
		expect(parseReconnectingStatus("Reconnecting soon")).toBeNull();
	});

	it("routes failures that stop the chat to the composer", () => {
		const notice = (message: string) =>
			describeProviderError({ kind: "generic", message }, "claude", local);

		expect(notice("You've hit your limit · resets 3pm")).toMatchObject({
			kind: "usage-limit",
		});
		expect(
			notice("Gemini CLI 0.1 does not support ACP; pass --experimental-acp"),
		).toEqual({ kind: "gemini-upgrade" });
		expect(isBlockingNotice(notice("You've hit your limit"))).toBe(true);
		expect(isBlockingNotice(notice("Reconnecting... 2/5"))).toBe(false);
		expect(isBlockingNotice(notice("Reconnecting... 5/5"))).toBe(true);
		expect(isBlockingNotice(notice("Something broke"))).toBe(false);
		expect(
			isBlockingNotice(
				describeProviderError(
					{ kind: "network", message: "socket hang up" },
					"claude",
					local,
				),
			),
		).toBe(false);
	});

	it("leaves in-app sign-in to the sign-in tray", () => {
		const signIn = describeProviderError(
			{ kind: "auth", message: "Not logged in" },
			"claude",
			local,
		);
		expect(signIn).toEqual({ kind: "sign-in", providerId: "claude" });
		expect(isBlockingNotice(signIn)).toBe(false);

		const settings = describeProviderError(
			{ kind: "auth", message: "Not logged in" },
			"codex",
			local,
		);
		expect(settings).toEqual({ kind: "auth", providerId: "codex" });
		expect(isBlockingNotice(settings)).toBe(true);
	});

	it("finds the failure the transcript ends on", () => {
		const message = (id: string, content: Message["content"]): Message =>
			({
				id,
				sessionId: "session-provider-error" as SessionId,
				role: "assistant",
				content,
				createdAt: new Date("2026-01-01T00:00:00Z"),
			}) as Message;
		const failed = message("failed", {
			_tag: "error",
			message: "You've hit your limit",
		});
		const usage = message("usage", { _tag: "usage" } as Message["content"]);
		const reply = message("reply", {
			_tag: "user",
			text: "again",
		} as Message["content"]);

		expect(latestTranscriptError([failed, usage])?.message.id).toBe("failed");
		expect(latestTranscriptError([failed, reply])).toBeNull();
		expect(latestTranscriptError([])).toBeNull();
	});
});
