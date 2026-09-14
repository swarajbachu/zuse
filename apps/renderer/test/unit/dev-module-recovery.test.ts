import { afterEach, describe, expect, it, vi } from "vitest";
import { createModuleRecovery } from "../../src/lib/dev-module-recovery.ts";

const failedImport = new TypeError(
	"Failed to fetch dynamically imported module: http://localhost:5734/src/components/browser-pane.tsx",
);
afterEach(() => vi.useRealTimers());
function fixture() {
	vi.useFakeTimers();
	const values = new Map<string, string>();
	const host = {
		storage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		},
		now: Date.now,
		ready: vi.fn(async () => true),
		reload: vi.fn(),
		delay: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
	};
	return { host, recover: createModuleRecovery(host) };
}
describe("dev module recovery", () => {
	it("recovers a native import error without a Vite preload event", async () => {
		const { host, recover } = fixture();
		expect(recover(failedImport)).toBe(true);
		await vi.advanceTimersByTimeAsync(500);
		expect(host.reload).toHaveBeenCalledOnce();
	});
	it("waits for server readiness and coalesces simultaneous failures", async () => {
		const { host, recover } = fixture();
		host.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
		recover(failedImport);
		recover(failedImport);
		await vi.advanceTimersByTimeAsync(1000);
		expect(host.reload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		expect(host.reload).toHaveBeenCalledOnce();
	});
	it("does not loop across document reloads", async () => {
		const { host, recover } = fixture();
		recover(failedImport);
		await vi.advanceTimersByTimeAsync(500);
		expect(createModuleRecovery(host)(failedImport)).toBe(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(createModuleRecovery(host)(failedImport)).toBe(true);
	});
	it("bounds retries while the server is unavailable", async () => {
		const { host, recover } = fixture();
		host.ready.mockResolvedValue(false);
		recover(failedImport);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(host.ready).toHaveBeenCalledTimes(10);
		expect(host.reload).not.toHaveBeenCalled();
	});
	it("keeps real application and hook errors visible", () => {
		const { recover } = fixture();
		expect(
			recover(
				new TypeError("Cannot read properties of null (reading 'useMemo')"),
			),
		).toBe(false);
		expect(recover(new SyntaxError("Unexpected token"))).toBe(false);
	});
	it("does not reload when session storage is unavailable", () => {
		const { host } = fixture();
		host.storage.getItem = () => {
			throw new Error("denied");
		};
		expect(createModuleRecovery(host)(failedImport)).toBe(false);
		expect(host.reload).not.toHaveBeenCalled();
	});
});
