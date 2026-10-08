import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";

const unlink = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runControlPlane: async (
		run: (client: unknown) => Effect.Effect<unknown>,
		options: unknown,
	) => {
		expect(options).toEqual({ scope: "account" });
		return Effect.runPromise(run({ "environments.remove": unlink }));
	},
}));

import { useEnvironmentCatalogStore } from "../../src/store/environment-catalog.ts";

const entry = {
	connectionKind: "api" as const,
	environmentId: "old-computer",
	profileId: null,
	label: "My Mac",
	target: null,
	descriptor: null,
	status: "offline" as const,
	error: null,
};
afterEach(() => {
	vi.clearAllMocks();
	useEnvironmentCatalogStore.setState({
		entries: [],
		activeEnvironmentId: undefined,
	});
});

it("unregisters a computer from the account before removing it locally", async () => {
	useEnvironmentCatalogStore.setState({
		entries: [entry],
		activeEnvironmentId: undefined,
	});
	unlink.mockReturnValue(Effect.void);
	await useEnvironmentCatalogStore
		.getState()
		.removeApiEnvironment(entry.environmentId);
	expect(unlink).toHaveBeenCalledWith({ environmentId: entry.environmentId });
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([]);
});
it("keeps the computer visible when backend deletion fails", async () => {
	useEnvironmentCatalogStore.setState({
		entries: [entry],
		activeEnvironmentId: undefined,
	});
	unlink.mockReturnValue(Effect.fail(new Error("offline")));
	await expect(
		useEnvironmentCatalogStore
			.getState()
			.removeApiEnvironment(entry.environmentId),
	).rejects.toThrow("offline");
	expect(useEnvironmentCatalogStore.getState().entries).toEqual([entry]);
});
it("does not unregister the active computer", async () => {
	useEnvironmentCatalogStore.setState({
		entries: [entry],
		activeEnvironmentId: entry.environmentId,
	});
	await expect(
		useEnvironmentCatalogStore
			.getState()
			.removeApiEnvironment(entry.environmentId),
	).rejects.toThrow("Switch");
	expect(unlink).not.toHaveBeenCalled();
});
