import { beforeEach, expect, test, vi } from "vitest";
import { createLinuxLocalConnectivity } from "../../src/linux-local-connectivity.ts";

const state = vi.hoisted(() => ({
	advertise: vi.fn<() => Promise<void>>(),
	shutdown: vi.fn<() => Promise<void>>(),
	createService: vi.fn(),
	getResponder: vi.fn(),
}));
vi.mock("@homebridge/ciao", () => ({ getResponder: state.getResponder }));

beforeEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
	state.advertise.mockResolvedValue();
	state.shutdown.mockResolvedValue();
	state.createService.mockReturnValue({
		advertise: state.advertise,
		on: vi.fn(),
	});
	state.getResponder.mockReturnValue({
		createService: state.createService,
		shutdown: state.shutdown,
	});
});

test("publishes the encrypted endpoint once and shuts down once", async () => {
	const publisher = createLinuxLocalConnectivity({
		serviceName: "Linux workstation",
		log: vi.fn(),
	});
	publisher.start(12345, "certificate-pin");
	publisher.start(23456, "another-pin");
	expect(state.createService).toHaveBeenCalledExactlyOnceWith({
		name: "Linux workstation",
		type: "zuse",
		port: 12345,
		txt: { tls: "certificate-pin" },
	});
	expect(state.advertise).toHaveBeenCalledTimes(1);
	await Promise.all([publisher.close(), publisher.close()]);
	expect(state.shutdown).toHaveBeenCalledTimes(1);
	publisher.start(12345);
	expect(state.getResponder).toHaveBeenCalledTimes(1);
});

test("retries advertisement failures and cancels pending retries on shutdown", async () => {
	vi.useFakeTimers();
	state.advertise.mockRejectedValue(new Error("network unavailable"));
	const log = vi.fn();
	const publisher = createLinuxLocalConnectivity({ serviceName: "Linux", log });
	try {
		publisher.start(12345, "pin");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.advertise).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith("local.publisher.failed", {
			reason: "network unavailable",
		});
		await publisher.close();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(state.advertise).toHaveBeenCalledTimes(2);
	} finally {
		await publisher.close();
		vi.useRealTimers();
	}
});

test("closing during advertisement cannot start another retry", async () => {
	let reject: (cause: unknown) => void = () => {};
	state.advertise.mockReturnValue(
		new Promise((_, rejectPromise) => {
			reject = rejectPromise;
		}),
	);
	const log = vi.fn();
	const publisher = createLinuxLocalConnectivity({ serviceName: "Linux", log });
	publisher.start(12345);
	await publisher.close();
	reject(new Error("cancelled"));
	await Promise.resolve();
	expect(log).not.toHaveBeenCalled();
	expect(state.shutdown).toHaveBeenCalledTimes(1);
});
