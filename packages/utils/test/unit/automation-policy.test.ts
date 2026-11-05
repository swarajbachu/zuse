import { type AutomationConfig, FolderId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { automationPolicyIssues } from "../../src/automation-policy.ts";

const config: AutomationConfig = {
	projectId: FolderId.make("repo"),
	name: "Triage",
	description: "",
	enabled: true,
	triggers: [{ _tag: "manual" }],
	action: "new_session",
	sessionId: null,
	prompt: "Triage issues",
	providerId: "claude",
	model: "claude-sonnet",
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
const local = { environment: "local", emailNotifications: false } as const;
const fields = (value: AutomationConfig, runtime = local) =>
	automationPolicyIssues(value, runtime).map((issue) => issue.field);

describe("automation policy", () => {
	it("accepts what the runtime can enforce", () => {
		expect(automationPolicyIssues(config, local)).toEqual([]);
	});
	it("rejects restrictions the runtime cannot enforce", () => {
		expect(
			fields({
				...config,
				runAs: "system",
				network: { enabled: true, allowedDomains: ["example.com"] },
			}),
		).toEqual(["runAs", "network"]);
		expect(fields({ ...config, environment: "cloud" })).toEqual([
			"environment",
		]);
	});
	it("enforces spending support and rejects obsolete native MCP selection", () => {
		expect(
			fields({ ...config, spendLimitUsd: 5, mcpServerIds: ["x"] }),
		).toEqual(["mcp"]);
		expect(fields({ ...config, spendLimitUsd: 5 })).toEqual([]);
		expect(
			fields({
				...config,
				providerId: "codex",
				spendLimitUsd: 5,
				mcpServerIds: ["x"],
			}),
		).toEqual(["spendLimit", "mcp"]);
		expect(
			fields({ ...config, allowChildSessions: true, spendLimitUsd: 5 }),
		).toEqual(["childSessions"]);
		expect(
			fields({
				...config,
				action: "existing_session",
				allowChildSessions: true,
				sessionId: SessionId.make("s1"),
				mcpServerIds: ["x"],
			}),
		).toEqual(["childSessions", "mcp"]);
	});
	it("requires a session and delegation policy for existing-session actions", () => {
		expect(fields({ ...config, action: "existing_session" })).toEqual([
			"childSessions",
			"session",
		]);
	});
	it("keeps automatic triage to Slack triggers", () => {
		expect(fields({ ...config, action: "auto_triage" })).toEqual(["action"]);
		expect(
			fields({
				...config,
				action: "auto_triage",
				triggers: [
					{
						_tag: "slack",
						events: ["message"],
						channelIds: [],
						keywords: [],
						includeBotMessages: false,
					},
				],
			}),
		).toEqual([]);
	});
	it("reports notification problems against the offending row", () => {
		const issues = automationPolicyIssues(
			{
				...config,
				notifications: [
					{ channel: "email", destination: "ops@example.com" },
					{ channel: "slack", destination: "C123" },
				],
			},
			local,
		);
		expect(issues.map((issue) => issue.index)).toEqual([0, 1]);
		expect(
			automationPolicyIssues(
				{
					...config,
					environment: "cloud",
					notifications: [
						{ channel: "email", destination: "not-an-email" },
						{ channel: "slack", destination: "T1/C123" },
					],
				},
				{ environment: "cloud", emailNotifications: true },
			),
		).toEqual([
			{
				field: "notifications",
				message: "Invalid email notification address.",
				index: 0,
			},
		]);
	});
	it("only runs on cloud machines where they can be started and enforced", () => {
		const cloud = {
			...config,
			allowChildSessions: true,
			cloudMachine: { providerId: "e2b", fallback: true },
		};
		const desktop = { ...local, cloudMachines: true };
		expect(fields(cloud, desktop)).toEqual([]);
		expect(fields(cloud)).toEqual(["machine"]);
		expect(fields({ ...cloud, allowChildSessions: false }, desktop)).toEqual([
			"childSessions",
		]);
		expect(fields({ ...cloud, action: "code_scan" }, desktop)).toEqual([
			"machine",
		]);
		expect(fields({ ...cloud, spendLimitUsd: 5 }, desktop)).toEqual([
			"spendLimit",
			"childSessions",
		]);
	});
});
