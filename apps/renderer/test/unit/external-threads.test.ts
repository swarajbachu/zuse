import { EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchEnvironmentShellCommand } = vi.hoisted(() => ({
	dispatchEnvironmentShellCommand: vi.fn(),
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand,
}));

import { useExternalThreadsStore } from "../../src/store/external-threads.ts";

describe("external thread routing", () => {
	beforeEach(() => {
		dispatchEnvironmentShellCommand.mockReset();
		useExternalThreadsStore.setState({
			threads: [],
			loading: false,
			environmentId: null,
			continuingId: null,
			error: null,
		});
	});

	it("discovers threads on the explicitly selected computer", async () => {
		const environmentId = EnvironmentId.make("selected-computer");
		dispatchEnvironmentShellCommand.mockResolvedValue({ result: [] });

		await useExternalThreadsStore.getState().hydrate(environmentId);

		expect(dispatchEnvironmentShellCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				environmentId,
				kind: "externalThreads.list",
			}),
		);
	});

	it("does not let a stale computer response replace the current menu", async () => {
		let resolveFirst: ((value: unknown) => void) | undefined;
		dispatchEnvironmentShellCommand
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce({ result: [{ id: "current" }] });

		const first = useExternalThreadsStore
			.getState()
			.hydrate(EnvironmentId.make("old-computer"));
		await useExternalThreadsStore
			.getState()
			.hydrate(EnvironmentId.make("current-computer"));
		resolveFirst?.({ result: [{ id: "stale" }] });
		await first;

		expect(useExternalThreadsStore.getState().threads).toEqual([
			{ id: "current" },
		]);
	});

	it("retries an interrupted list request without surfacing a false load error", async () => {
		const environmentId = EnvironmentId.make("selected-computer");
		dispatchEnvironmentShellCommand
			.mockRejectedValueOnce(new Error("All fibers interrupted without error"))
			.mockResolvedValueOnce({ result: [{ id: "recovered" }] });

		await useExternalThreadsStore.getState().hydrate(environmentId);

		expect(dispatchEnvironmentShellCommand).toHaveBeenCalledTimes(2);
		expect(useExternalThreadsStore.getState()).toMatchObject({
			threads: [{ id: "recovered" }],
			loading: false,
			error: null,
		});
	});

	it("keeps cached chats when an interrupted retry is also cancelled", async () => {
		const environmentId = EnvironmentId.make("selected-computer");
		useExternalThreadsStore.setState({
			threads: [{ id: "cached" }] as never,
			environmentId,
		});
		dispatchEnvironmentShellCommand.mockRejectedValue(
			new Error("All fibers interrupted without error"),
		);

		await useExternalThreadsStore.getState().hydrate(environmentId);

		expect(useExternalThreadsStore.getState()).toMatchObject({
			threads: [{ id: "cached" }],
			loading: false,
			error: null,
		});
	});
});
