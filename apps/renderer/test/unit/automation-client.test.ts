import {
	type Automation,
	type AutomationConfig,
	FolderId,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: dispatch,
}));

import { automationClient } from "../../src/lib/automation-client.ts";

const config: AutomationConfig = {
	projectId: FolderId.make("repo"),
	name: "Triage",
	description: "",
	enabled: false,
	triggers: [{ _tag: "manual" }],
	action: "new_session",
	sessionId: null,
	prompt: "Triage issues",
	providerId: "codex",
	model: "gpt-6",
	modelOptions: {},
	runtimeMode: "approval-required",
	runAs: "owner",
	worktreeId: null,
	environment: "local",
	mcpServerIds: [],
	allowChildSessions: false,
	network: { enabled: true, allowedDomains: [] },
	metadata: {},
	spendLimitUsd: null,
	rateLimit: { count: 5, windowSeconds: 3600 },
	queue: { enabled: true, maxConcurrency: 1 },
	notifications: [],
};
const record: Automation = {
	id: "a1",
	revision: 7,
	config,
	createdAt: "2026-10-04T00:00:00Z",
	updatedAt: "2026-10-04T00:00:00Z",
	nextRunAt: null,
};
beforeEach(() => {
	dispatch.mockReset();
	dispatch.mockResolvedValue({ result: record });
});
describe("automation environment commands", () => {
	it("targets the captured environment for reads and mutations", async () => {
		const client = automationClient("cloud-a");
		await client.list();
		await client.save(config);
		await client.runs("a1");
		await client.cancel("run1");
		await client.templates();
		expect(
			dispatch.mock.calls.every(
				([command]) => command.environmentId === "cloud-a",
			),
		).toBe(true);
		expect(dispatch.mock.calls.map(([command]) => command.kind)).toEqual([
			"automation.list",
			"automation.save",
			"automation.runs",
			"automation.cancel",
			"automation.templates",
		]);
	});
	it("includes the revision when editing so stale editors cannot overwrite newer changes", async () => {
		await automationClient("local").save(
			{ ...config, name: "Updated" },
			record,
		);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: {
					id: "a1",
					expectedRevision: 7,
					config: { ...config, name: "Updated" },
				},
			}),
		);
	});
	it("preserves the run request identity and never retries an ambiguous mutation automatically", async () => {
		const client = automationClient("local");
		dispatch.mockRejectedValueOnce(new Error("Connection lost"));
		await expect(client.run("a1", "stable-request")).rejects.toThrow(
			"Connection lost",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				retry: "never",
				payload: { id: "a1", requestId: "stable-request" },
			}),
		);
	});
	it("preserves a creation key across caller retries", async () => {
		const client = automationClient("local");
		await client.save(config, undefined, "create-key");
		await client.save(config, undefined, "create-key");
		expect(
			dispatch.mock.calls.every(
				([command]) => command.payload.requestId === "create-key",
			),
		).toBe(true);
	});
});
