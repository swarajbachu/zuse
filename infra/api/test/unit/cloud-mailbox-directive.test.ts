import { describe, expect, test } from "vitest";

import {
	attachCloudMailboxBillingDirective,
	attachCloudMailboxCommandDirective,
	attachCloudMailboxLifecycleDirective,
	type CloudMailboxCommandDirective,
	takeCloudMailboxDirective,
} from "../../src/cloud-mailbox-directive.ts";

describe("cloud mailbox internal directive", () => {
	test("round-trips every command action through one typed parser", () => {
		const commands: ReadonlyArray<CloudMailboxCommandDirective> = [
			{
				action: "enqueue",
				workspaceId: "workspace-1",
				accountId: "account-1",
			},
			{ action: "status", workspaceId: "workspace-1" },
			{ action: "watch", workspaceId: "workspace-1" },
			{ action: "cancel", workspaceId: "workspace-1" },
			{ action: "ack", workspaceId: "workspace-1" },
			{
				action: "lease",
				workspaceId: "workspace-1",
				runtimeGeneration: 4,
				wakeRevision: 9,
			},
		];

		for (const command of commands) {
			const response = new Response();
			attachCloudMailboxCommandDirective(response, command);
			if (
				command.action === "status" ||
				command.action === "watch" ||
				command.action === "lease"
			)
				attachCloudMailboxBillingDirective(response, {
					policy: "available",
					accountId: "account-1",
				});

			expect(takeCloudMailboxDirective(response)).toEqual({
				kind: "directive",
				directive: {
					command,
					...(command.action === "status" ||
					command.action === "watch" ||
					command.action === "lease"
						? {
								billing: {
									policy: "available",
									accountId: "account-1",
								},
							}
						: {}),
				},
			});
			const mailboxHeaders: Array<string> = [];
			response.headers.forEach((_value, name) => {
				if (name.startsWith("x-zuse-mailbox-")) mailboxHeaders.push(name);
			});
			expect(mailboxHeaders).toEqual([]);
		}
	});

	test("combines destructive lifecycle and command routing atomically", () => {
		const response = new Response();
		attachCloudMailboxCommandDirective(response, {
			action: "cancel",
			workspaceId: "workspace-1",
		});
		attachCloudMailboxLifecycleDirective(response, {
			workspaceId: "workspace-1",
			action: "delete",
			destructionFence: 3,
		});

		expect(takeCloudMailboxDirective(response)).toEqual({
			kind: "directive",
			directive: {
				command: {
					action: "cancel",
					workspaceId: "workspace-1",
				},
				lifecycle: {
					workspaceId: "workspace-1",
					action: "delete",
					destructionFence: 3,
				},
			},
		});
	});

	test("rejects malformed directives instead of partially applying them", () => {
		const response = new Response(null, {
			headers: {
				"x-zuse-mailbox-action": "lease",
				"x-zuse-mailbox-workspace": "workspace-1",
				"x-zuse-mailbox-runtime-generation": "not-a-number",
				"x-zuse-mailbox-billing-policy": "available",
				"x-zuse-mailbox-account": "account-1",
			},
		});

		expect(takeCloudMailboxDirective(response)).toEqual({
			kind: "invalid",
			reason: "invalid-runtime-generation",
		});
	});
});
