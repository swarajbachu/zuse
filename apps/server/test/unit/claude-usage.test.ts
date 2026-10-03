import { beforeEach, describe, expect, it, vi } from "vitest";

const { usage, accountInfo } = vi.hoisted(() => ({
	usage: vi.fn(),
	accountInfo: vi.fn(),
}));
vi.mock("@zuse/agents/drivers/claude-control-client", () => ({
	withClaudeControlClient: vi.fn((_args, run) =>
		run({
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
			accountInfo,
		}),
	),
}));

import { fetchClaudeUsage } from "../../src/usage/limits/claude-usage.ts";

const args = {
	claudeExecutablePath: "/custom/claude",
	credential: null,
	cwd: "/tmp",
	timeoutMs: 1000,
};
describe("Claude CLI usage", () => {
	beforeEach(() => {
		usage.mockReset();
		accountInfo.mockReset();
		accountInfo.mockResolvedValue({ apiKeySource: "user" });
	});
	it("reads subscription and model limits through the CLI", async () => {
		usage.mockResolvedValue({
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 0.5 },
				seven_day: { utilization: 1 },
				model_scoped: [{ display_name: "Fable", utilization: 30 }],
			},
		});
		const value = await fetchClaudeUsage(args);
		expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
		expect(value.planLabel).toBe("max");
		expect(value.windows.map((w) => w.usedPercent)).toEqual([0.5, 1, 30]);
	});
	it("distinguishes unsupported accounts and old CLIs", async () => {
		usage.mockResolvedValue({
			rate_limits_available: false,
			rate_limits: null,
		});
		expect((await fetchClaudeUsage(args)).unavailableReason).toBe(
			"unsupported",
		);
		usage.mockRejectedValue(new Error("Unknown control request: get_usage"));
		expect((await fetchClaudeUsage(args)).unavailableReason).toBe(
			"unsupported-version",
		);
	});
	it("asks for sign-in when the CLI itself has no credentials", async () => {
		accountInfo.mockResolvedValue({
			tokenSource: "none",
			apiKeySource: "none",
			apiProvider: "firstParty",
		});
		usage.mockResolvedValue({
			rate_limits_available: false,
			subscription_type: null,
			rate_limits: null,
		});
		expect((await fetchClaudeUsage(args)).unavailableReason).toBe(
			"no-credentials",
		);
	});

	it("reports a missing CLI and malformed response", async () => {
		expect(
			(await fetchClaudeUsage({ ...args, claudeExecutablePath: null }))
				.unavailableReason,
		).toBe("cli-unavailable");
		expect(usage).not.toHaveBeenCalled();
		usage.mockResolvedValue({ nonsense: true });
		expect((await fetchClaudeUsage(args)).unavailableReason).toBe(
			"invalid-response",
		);
	});
});
