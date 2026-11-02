import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { loadMuseInventory } from "@zuse/agents/drivers/muse-client";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { ConfigStoreServiceLive } from "../../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ModelCatalogServiceLive } from "../../src/model-catalog/layers/model-catalog-service.ts";
import { ModelCatalogService } from "../../src/model-catalog/services/model-catalog-service.ts";
import { makeFileCredentialsService } from "../../src/provider/layers/file-credentials-service.ts";

vi.mock("@zuse/agents/drivers/muse-client", () => ({
	loadMuseInventory: vi.fn(),
}));

it("coalesces Muse inventory reads, discovers native models, and retries after invalidation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zuse-muse-catalog-"));
	vi.stubEnv("ZUSE_CONFIG_DIR", join(dir, "config"));
	const dependencies = Layer.mergeAll(
		ConfigStoreServiceLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: dir })),
			Layer.provide(NodeServices.layer),
		),
		makeFileCredentialsService(dir),
		Layer.succeed(AppPaths, { userData: dir }),
		NodeServices.layer,
	);
	const runtime = ManagedRuntime.make(
		ModelCatalogServiceLive.pipe(Layer.provideMerge(dependencies)),
	);
	const load = vi.mocked(loadMuseInventory);
	load.mockImplementation(() =>
		Effect.sleep("50 millis").pipe(
			Effect.as([
				{
					id: "test/model",
					label: "Test",
					isDefault: true,
					liveMeta: { reasoningEfforts: ["high", "max"] },
				},
			]),
		),
	);
	try {
		await runtime.runPromise(
			Effect.flatMap(ConfigStoreService, (config) =>
				config.updateSettings({
					providerBinaryPaths: { muse: process.execPath },
				}),
			),
		);
		const catalog = await runtime.runPromise(ModelCatalogService);
		await Promise.all([
			runtime.runPromise(catalog.refresh({ live: ["muse"] })),
			runtime.runPromise(catalog.refresh({ live: ["muse"] })),
		]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(process.execPath, dir);
		const current = await runtime.runPromise(catalog.current());
		expect(current.providers.muse.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "test/model",
					available: true,
					supportsPlanMode: false,
				}),
			]),
		);
		await runtime.runPromise(catalog.current());
		expect(load).toHaveBeenCalledTimes(1);
		load.mockImplementationOnce(() => Effect.fail(new Error("Probe failed")));
		await runtime.runPromise(catalog.invalidateLive("muse"));
		expect(
			(await runtime.runPromise(catalog.refresh({ live: ["muse"] }))).providers
				.muse.live.status,
		).toBe("error");
		expect(
			(await runtime.runPromise(catalog.refresh({ live: ["muse"] }))).providers
				.muse.live.status,
		).toBe("ok");
		expect(load).toHaveBeenCalledTimes(3);
	} finally {
		await runtime.dispose();
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	}
});
