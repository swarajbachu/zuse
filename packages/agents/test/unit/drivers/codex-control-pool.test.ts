import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../../../src/drivers/codex-app-server-client.ts";

// Spaced metadata reads should not each trigger a catalog fetch at startup.
describe("Codex control process lifetime", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	it("reuses the control process across spaced metadata reads", async () => {
		vi.useFakeTimers();
		const close = vi.fn(async () => {});
		const start = vi
			.spyOn(CodexAppServerClient, "start")
			.mockResolvedValue({ close } as unknown as CodexAppServerClient);
		const { withCodexControlClient } = await import(
			"../../../src/drivers/codex-control-client.ts"
		);
		for (let i = 0; i < 4; i++) {
			await withCodexControlClient(null, async () => undefined);
			await vi.advanceTimersByTimeAsync(60_000);
		}
		expect(start).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("replaces a terminated control process without retrying its failed operation", async () => {
		vi.useFakeTimers();
		const close = vi.fn(async () => {});
		const start = vi
			.spyOn(CodexAppServerClient, "start")
			.mockResolvedValue({ close } as unknown as CodexAppServerClient);
		const { withCodexControlClient } = await import(
			"../../../src/drivers/codex-control-client.ts"
		);
		const operation = vi.fn(async () => {
			throw new Error("closed");
		});
		await withCodexControlClient("/test/terminated", async () => undefined);
		start.mock.calls[0]?.[0].onUnexpectedTermination?.(
			new Error("process exited"),
		);
		await expect(
			withCodexControlClient("/test/terminated", operation),
		).rejects.toThrow("closed");
		expect(start).toHaveBeenCalledTimes(2);
		expect(operation).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
	});

	it("keeps different account homes isolated", async () => {
		vi.useFakeTimers();
		const start = vi
			.spyOn(CodexAppServerClient, "start")
			.mockImplementation(
				async () =>
					({ close: vi.fn(async () => {}) }) as unknown as CodexAppServerClient,
			);
		const { withCodexControlClient } = await import(
			"../../../src/drivers/codex-control-client.ts"
		);
		const first = await withCodexControlClient(
			null,
			async (client) => client,
			"/test/account-one",
		);
		const second = await withCodexControlClient(
			null,
			async (client) => client,
			"/test/account-two",
		);
		expect(first).not.toBe(second);
		expect(start).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
	});
});
