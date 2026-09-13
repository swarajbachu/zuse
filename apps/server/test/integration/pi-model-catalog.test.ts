import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { loadPiInventory } from "@zuse/agents/drivers/pi-inventory";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { ConfigStoreServiceLive } from "../../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ModelCatalogServiceLive } from "../../src/model-catalog/layers/model-catalog-service.ts";
import { ModelCatalogService } from "../../src/model-catalog/services/model-catalog-service.ts";
import { makeFileCredentialsService } from "../../src/provider/layers/file-credentials-service.ts";

vi.mock("@zuse/agents/drivers/pi-inventory", () => ({
	loadPiInventory: vi.fn(),
}));

it("coalesces Pi inventory reads, preserves Auto, and retries after invalidation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zuse-pi-catalog-"));
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
	const load = vi.mocked(loadPiInventory);
	load.mockImplementation(() =>
		Effect.sleep("50 millis").pipe(
			Effect.as([
				{
					id: "test/model",
					label: "Test",
					liveMeta: { contextWindowTokens: 1000 },
				},
			]),
		),
	);
	try {
		await runtime.runPromise(
			Effect.flatMap(ConfigStoreService, (config) =>
				config.updateSettings({
					providerBinaryPaths: { pi: process.execPath },
				}),
			),
		);
		const catalog = await runtime.runPromise(ModelCatalogService);
		await Promise.all([
			runtime.runPromise(catalog.refresh({ live: ["pi"] })),
			runtime.runPromise(catalog.refresh({ live: ["pi"] })),
		]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(process.execPath);
		const current = await runtime.runPromise(catalog.current());
		expect(current.providers.pi.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "auto",
					available: true,
					supportsPlanMode: false,
				}),
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
		await runtime.runPromise(catalog.invalidateLive("pi"));
		expect(
			(await runtime.runPromise(catalog.refresh({ live: ["pi"] }))).providers.pi
				.live.status,
		).toBe("error");
		expect(
			(await runtime.runPromise(catalog.refresh({ live: ["pi"] }))).providers.pi
				.live.status,
		).toBe("ok");
		expect(load).toHaveBeenCalledTimes(3);
	} finally {
		await runtime.dispose();
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	}
});
