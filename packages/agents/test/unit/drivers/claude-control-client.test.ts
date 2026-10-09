import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
	...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
	query,
}));

import { withClaudeControlClient } from "../../../src/drivers/claude-control-client.ts";
import { listClaudeModels } from "../../../src/drivers/claude-models.ts";

const options = {
	claudeExecutablePath: "/custom/claude",
	credential: null,
	cwd: "/tmp",
	timeoutMs: 100,
};
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	query.mockReset();
});
describe("Claude control query lifecycle", () => {
	it("uses the named account for identity and usage without inherited tokens", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "default-key");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "default-token");
		query.mockReturnValue({ close: vi.fn() });
		await withClaudeControlClient(
			{ ...options, accountHome: "/accounts/work" },
			async () => "ok",
		);
		const env = query.mock.calls[0]?.[0].options.env;
		expect(env.CLAUDE_CONFIG_DIR).toBe("/accounts/work");
		expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/accounts/work");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});
	it("delegates credential resolution and custom config to the CLI without submitting a turn", async () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/custom/config");
		const close = vi.fn();
		query.mockReturnValue({ close });
		expect(await withClaudeControlClient(options, async () => "result")).toBe(
			"result",
		);
		const call = query.mock.calls[0]?.[0];
		expect(call.options).toMatchObject({
			pathToClaudeCodeExecutable: "/custom/claude",
			persistSession: false,
			tools: [],
			env: { CLAUDE_CONFIG_DIR: "/custom/config" },
		});
		expect(await call.prompt[Symbol.asyncIterator]().next()).toMatchObject({
			done: true,
		});
		expect(close).toHaveBeenCalledOnce();
	});
	it("aborts and closes a hung query", async () => {
		vi.useFakeTimers();
		const close = vi.fn();
		query.mockReturnValue({ close });
		const pending = withClaudeControlClient(
			options,
			() => new Promise(() => {}),
		);
		const rejected = expect(pending).rejects.toMatchObject({
			name: "TimeoutError",
		});
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
		expect(close).toHaveBeenCalledOnce();
		expect(
			query.mock.calls[0]?.[0].options.abortController.signal.aborted,
		).toBe(true);
	});
	it("closes on failure and lists models through the same helper", async () => {
		const close = vi.fn();
		query.mockReturnValue({
			close,
			supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet" }],
		});
		await expect(
			withClaudeControlClient(options, async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(await listClaudeModels(options)).toMatchObject([
			{ id: "sonnet", label: "Sonnet" },
		]);
		expect(close).toHaveBeenCalledTimes(2);
	});
});
