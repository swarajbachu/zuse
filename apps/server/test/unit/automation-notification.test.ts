import type { Automation, AutomationRun } from "@zuse/contracts";
import { describe, expect, test, vi } from "vitest";
import {
	deliverAutomationNotification,
	emailNotificationsConfigured,
} from "../../src/automation/notification.ts";

const automation = { config: { name: "Daily report" } } as Automation;
const run = {
	id: "run-1",
	status: "completed",
	sessionId: "session-1",
	error: null,
} as AutomationRun;
const notification = {
	channel: "email" as const,
	destination: "owner@example.com",
};
const env = {
	ZUSE_AUTOMATION_EMAIL_API_KEY: "test-secret",
	ZUSE_AUTOMATION_EMAIL_FROM: "zuse@example.com",
};

describe("automation email outbox adapter", () => {
	test("fails before delivery if mail transport is unconfigured", async () => {
		const send = vi.fn<typeof fetch>();
		expect(emailNotificationsConfigured({})).toBe(false);
		await expect(
			deliverAutomationNotification(
				{ run, automation, notification },
				{ env: {}, fetch: send },
			),
		).rejects.toThrow("Configure");
		expect(send).not.toHaveBeenCalled();
	});
	test("retries use a stable idempotency key and fixed HTTPS destination", async () => {
		const send = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response("{}"));
		await deliverAutomationNotification(
			{ run, automation, notification },
			{ env, fetch: send },
		);
		await deliverAutomationNotification(
			{ run, automation, notification },
			{ env, fetch: send },
		);
		expect(send.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
		expect(send.mock.calls[0]?.[1]?.headers).toEqual(
			send.mock.calls[1]?.[1]?.headers,
		);
		expect(send.mock.calls[0]?.[1]?.redirect).toBe("error");
		expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
			to: [notification.destination],
			subject: "Daily report: completed",
		});
	});
	test("does not expose provider response bodies in persisted failures", async () => {
		const send = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response("private diagnostic token", { status: 429 }),
			);
		await expect(
			deliverAutomationNotification(
				{ run, automation, notification },
				{ env, fetch: send },
			),
		).rejects.toThrow("Email notification delivery failed (HTTP 429).");
	});
	test("rejects invalid destinations and nonterminal runs", async () => {
		const send = vi.fn<typeof fetch>();
		await expect(
			deliverAutomationNotification(
				{
					run,
					automation,
					notification: { ...notification, destination: "bad\naddress" },
				},
				{ env, fetch: send },
			),
		).rejects.toThrow("Invalid email");
		await expect(
			deliverAutomationNotification(
				{ run: { ...run, status: "running" }, automation, notification },
				{ env, fetch: send },
			),
		).rejects.toThrow("terminal");
		expect(send).not.toHaveBeenCalled();
	});
});
