import type { AgentAvailability, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	toast: vi.fn(),
	activeEnvironmentId: "local",
	usageLoading: vi.fn(),
	usageGate: null as Promise<void> | null,
}));

vi.mock("../../src/lib/deferred-runtime.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/lib/deferred-runtime.ts")>();
	return {
		...actual,
		createDeferredRuntime: <Runtime>(load: () => Promise<Runtime>) =>
			actual.createDeferredRuntime(async () => {
				mocks.usageLoading();
				if (mocks.usageGate) await mocks.usageGate;
				return load();
			}),
	};
});

vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: mocks.toast },
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: mocks.dispatch,
}));

vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: mocks.activeEnvironmentId }),
	},
}));

const { useUsageLimitsStore } = await import("../../src/store/usage-limits.ts");
const { useProvidersStore } = await import("../../src/store/providers.ts");

const availability = (providerId: "codex" | "claude"): AgentAvailability => ({
	providerId,
	displayName: providerId,
	cliInstalled: true,
	cliLoggedIn: true,
	hasApiKey: false,
	authStatus: "authenticated",
});

describe("provider availability by environment", () => {
	beforeEach(() => {
		mocks.activeEnvironmentId = "local";
		mocks.dispatch.mockReset();
		mocks.toast.mockReset();
		mocks.usageLoading.mockClear();
		mocks.usageGate = null;
		useProvidersStore.setState({
			availability: [],
			availabilityByEnvironment: {},
			availabilityLoaded: false,
			loading: false,
			error: null,
		});
	});
	it("keeps discovery lightweight and rejects stale results after deferred usage loading", async () => {
		const original = [
			{ ...availability("claude"), authEmail: "original@example.com" },
		];
		mocks.dispatch.mockResolvedValueOnce({ result: original });
		await useProvidersStore.getState().refresh();
		expect(mocks.usageLoading).not.toHaveBeenCalled();

		let release!: () => void;
		mocks.usageGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.dispatch.mockResolvedValueOnce({
			result: [
				{ ...availability("claude"), authEmail: "outdated@example.com" },
			],
		});
		const older = useProvidersStore.getState().refresh();
		try {
			await vi.waitFor(() => expect(mocks.usageLoading).toHaveBeenCalled());
			// The newest response needs no invalidation, so it finishes while usage
			// loading is still holding the outdated discovery response.
			mocks.dispatch.mockResolvedValueOnce({ result: original });
			await useProvidersStore.getState().refresh();
		} finally {
			release();
		}
		await older;
		expect(useProvidersStore.getState().availability).toEqual(original);
	});

	it("loads a cloud runtime without overwriting local provider state", async () => {
		const cloudAvailability = [availability("codex")];
		mocks.dispatch.mockResolvedValue({ result: cloudAvailability });

		const state =
			useProvidersStore.getState() as typeof useProvidersStore extends {
				getState: () => infer State;
			}
				? State & {
						refreshFor: (
							environmentId: EnvironmentId,
							force?: boolean,
						) => Promise<void>;
						availabilityByEnvironment: Readonly<
							Record<
								string,
								{ readonly availability: ReadonlyArray<AgentAvailability> }
							>
						>;
					}
				: never;
		await state.refreshFor("cloud-workspace" as EnvironmentId);

		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ environmentId: "cloud-workspace" }),
		);
		expect(
			useProvidersStore.getState().availabilityByEnvironment["cloud-workspace"]
				?.availability,
		).toEqual(cloudAvailability);
		expect(useProvidersStore.getState().availability).toEqual([]);
	});
	it("ignores an older account response after a newer availability refresh", async () => {
		let resolve!: (value: unknown) => void;
		mocks.dispatch.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const older = useProvidersStore.getState().refresh();
		const current = [
			{ ...availability("claude"), authEmail: "new@example.com" },
		];
		mocks.dispatch.mockResolvedValueOnce({ result: current });
		await useProvidersStore.getState().refresh();
		const invalidate = vi.spyOn(useUsageLimitsStore.getState(), "invalidate");
		resolve({
			result: [{ ...availability("claude"), authEmail: "old@example.com" }],
		});
		await older;
		expect(useProvidersStore.getState().availability).toEqual(current);
		expect(invalidate).not.toHaveBeenCalled();
		invalidate.mockRestore();
	});
	it.each([
		["local", "remote", true],
		["remote", "local", false],
	])("keeps removal bound to %s when switching to %s", async (initial, next, shouldInvalidate) => {
		mocks.activeEnvironmentId = initial;
		let resolve!: (value: unknown) => void;
		mocks.dispatch.mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mocks.dispatch.mockResolvedValue({ result: [] });
		const invalidate = vi.spyOn(useUsageLimitsStore.getState(), "invalidate");
		const pending = useProvidersStore.getState().removeCredential("claude");
		mocks.activeEnvironmentId = next;
		resolve({ result: undefined });
		await pending;
		expect(invalidate.mock.calls.length > 0).toBe(shouldInvalidate);
		invalidate.mockRestore();
	});
});
