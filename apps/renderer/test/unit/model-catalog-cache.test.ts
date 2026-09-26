import { bundledResolvedModelCatalog } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	activeEnvironmentId: "local",
	dispatch: vi.fn(),
}));

vi.mock("../../src/lib/environment-shell-client-bus.ts", () => ({
	dispatchEnvironmentShellCommand: mocks.dispatch,
}));

vi.mock("../../src/store/environment-catalog.ts", () => ({
	useEnvironmentCatalogStore: {
		getState: () => ({ activeEnvironmentId: mocks.activeEnvironmentId }),
	},
}));

const { resetModelCatalogForEnvironment, useModelCatalogStore } = await import(
	"../../src/store/model-catalog.ts"
);

describe("model catalog cache", () => {
	beforeEach(() => {
		mocks.activeEnvironmentId = "local";
		mocks.dispatch.mockReset();
		resetModelCatalogForEnvironment();
	});

	it("loads once per environment", async () => {
		mocks.dispatch.mockResolvedValue({ result: bundledResolvedModelCatalog() });

		await useModelCatalogStore.getState().ensureLoaded();
		await useModelCatalogStore.getState().ensureLoaded();
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);

		mocks.activeEnvironmentId = "remote";
		await useModelCatalogStore.getState().ensureLoaded();
		expect(mocks.dispatch).toHaveBeenCalledTimes(2);
		expect(useModelCatalogStore.getState().loadedEnvironmentId).toBe("remote");
	});

	it("retries after a failed load", async () => {
		mocks.dispatch
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ result: bundledResolvedModelCatalog() });

		await useModelCatalogStore.getState().ensureLoaded();
		expect(useModelCatalogStore.getState().loadedEnvironmentId).toBeNull();

		await useModelCatalogStore.getState().ensureLoaded();
		expect(mocks.dispatch).toHaveBeenCalledTimes(2);
		expect(useModelCatalogStore.getState().loadedEnvironmentId).toBe("local");
	});
});
