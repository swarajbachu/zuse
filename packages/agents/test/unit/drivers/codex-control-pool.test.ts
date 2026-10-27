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
		const first = {
			close: vi.fn(async () => {}),
		} as unknown as CodexAppServerClient;
		const second = {
			close: vi.fn(async () => {}),
		} as unknown as CodexAppServerClient;
		const start = vi
			.spyOn(CodexAppServerClient, "start")
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(second);
		const { withCodexControlClient } = await import(
			"../../../src/drivers/codex-control-client.ts"
		);
		let rejectOperation!: (error: Error) => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = vi.fn((client: CodexAppServerClient) => {
			expect(client).toBe(first);
			return new Promise<void>((_resolve, reject) => {
				rejectOperation = reject;
				markStarted();
			});
		});
		const interrupted = withCodexControlClient("/test/terminated", operation);
		const rejected = expect(interrupted).rejects.toThrow("process exited");
		await started;
		start.mock.calls[0]?.[0].onUnexpectedTermination?.(
			new Error("process exited"),
		);
		rejectOperation(new Error("process exited"));
		await rejected;
		expect(operation).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledTimes(1);
		const next = await withCodexControlClient(
			"/test/terminated",
			async (client) => client,
		);
		expect(next).toBe(second);
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
	it("closes idle control processes immediately on shutdown and permits a new lifecycle", async () => {
		vi.useFakeTimers();
		const close = vi.fn(async () => {});
		const start = vi
			.spyOn(CodexAppServerClient, "start")
			.mockResolvedValue({ close } as unknown as CodexAppServerClient);
		const { withCodexControlClient, closeCodexControlClients } = await import(
			"../../../src/drivers/codex-control-client.ts"
		);
		await withCodexControlClient("/test/shutdown", async () => undefined);
		await closeCodexControlClients();
		expect(close).toHaveBeenCalledTimes(1);
		await withCodexControlClient("/test/shutdown", async () => undefined);
		expect(start).toHaveBeenCalledTimes(2);
		await closeCodexControlClients();
		expect(close).toHaveBeenCalledTimes(2);
	});
});
