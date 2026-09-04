import type { AgentAvailability, EnvironmentId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: mocks.toast },
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: mocks.dispatch,
}));

vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: "local" }),
	},
}));

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
		mocks.dispatch.mockReset();
		mocks.toast.mockReset();
		useProvidersStore.setState({
			availability: [],
			availabilityByEnvironment: {},
			availabilityLoaded: false,
			loading: false,
			error: null,
		});
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
});
