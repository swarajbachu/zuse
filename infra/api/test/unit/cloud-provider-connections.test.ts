import {
	makeSandboxProviders,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { cloudBillingCapacity } from "../../src/cloud-billing-capacity.ts";
import { meterProviderExecution } from "../../src/cloud-billing-provider.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	accountSandboxProviders,
	CloudProviderConnections,
	listProviderConnections,
	type ProviderConnectionRecord,
	resolveConnectedProvider,
	resolveResourceProvider,
	saveProviderConnection,
} from "../../src/cloud-provider-connections.ts";
import { reserveProviderCost } from "../../src/cloud-workspace-reconciler.ts";
import { requireCloudWorkspaceEntitlement } from "../../src/cloud-workspace-routes.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configLayer } from "../../src/config.ts";
import { MachineStoreMemory } from "../../src/machine-store.ts";

const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error("Expected test fixture value");
	return value;
};

const setup = () => {
	const records = new Map<string, ProviderConnectionRecord>();
	const calls: string[] = [];
	const storage = CloudProviderConnections.of({
		list: (account) =>
			Effect.sync(() =>
				[...records.values()].filter((record) => record.accountId === account),
			),
		save: (record) =>
			Effect.sync(() => {
				for (const [id, previous] of records)
					if (
						previous.accountId === record.accountId &&
						previous.providerId === record.providerId
					)
						records.set(id, { ...previous, active: false });
				records.set(record.connectionId, record);
			}),
		disconnect: (account, id) =>
			Effect.sync(() => {
				const record = records.get(id);
				if (record?.accountId === account)
					records.set(id, { ...record, active: false });
			}),
	});
	const providers = Layer.effect(
		SandboxProviders,
		Effect.gen(function* () {
			const fake = yield* (yield* SandboxProviders).get("fake");
			return yield* makeSandboxProviders({
				defaultProviderId: "boxd",
				registrations: ["boxd", "e2b", "box"].map((providerId) => ({
					adapter: {
						...fake,
						providerId,
						withCredentials: (credentials) => ({
							...fake,
							providerId,
							recoverByLabel: () =>
								Redacted.value(credentials.apiKey) === "invalid"
									? Effect.fail(new SandboxProviderError({ code: "rejected" }))
									: Effect.succeed(null),
							pause: () =>
								Effect.sync(() => {
									calls.push(Redacted.value(credentials.apiKey));
								}),
						}),
					},
				})),
			});
		}),
	).pipe(Layer.provide(SandboxProvidersFake), Layer.orDie);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			providers,
			Layer.succeed(CloudProviderConnections, storage),
			CloudWorkspaceStoreMemory,
			CloudBillingStoreMemory,
			MachineStoreMemory,
			configLayer({
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://unused.test",
				workosIssuer: "https://unused.test",
				mintPrivateKey: Redacted.make("{}"),
				mintPublicKey: "{}",
				cloudDataEncryptionKey: Redacted.make(
					"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				),
				cloudBillingEnforcementEnabled: true,
				cloudBillingExportEnabled: true,
				cloudUsageExportEnabled: true,
			}),
		),
	);
	return { records, calls, storage, runtime };
};
const build = (connectionId: string): CloudProjectBuildRecord => ({
	buildId: "build",
	projectId: "project",
	accountId: "alice",
	provider: "boxd",
	providerSandboxId: "sandbox",
	templateVersion: "v1",
	configurationDigest: "digest",
	settings: { providerConnectionId: connectionId },
	state: "building",
	idempotencyKey: "build",
	nextActionAtMs: 0,
	revision: 0,
	createdAtMs: 0,
	updatedAtMs: 0,
});

describe("BYOK ownership and billing", () => {
	test.each([
		"e2b",
		"boxd",
		"box",
	] as const)("encrypts %s keys and grants free access only to their owner", async (providerId) => {
		const { runtime, records } = setup();
		try {
			const response = await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{
						providerId,
						apiKey: "private-provider-key",
						templateId: "my-template",
					},
					1,
				),
			);
			expect(response.connections).toHaveLength(1);
			expect(JSON.stringify(response)).not.toContain("private-provider-key");
			expect(JSON.stringify([...records.values()])).not.toContain(
				"private-provider-key",
			);
			expect(await runtime.runPromise(listProviderConnections("bob"))).toEqual(
				[],
			);
			await runtime.runPromise(requireCloudWorkspaceEntitlement("alice", 1));
			await expect(
				runtime.runPromise(requireCloudWorkspaceEntitlement("bob", 1)),
			).rejects.toMatchObject({ code: "cloud_entitlement_required" });
		} finally {
			await runtime.dispose();
		}
	});
	test("rotation and disconnect preserve pinned credentials and reject cross-account use", async () => {
		const { runtime, storage, calls } = setup();
		try {
			const first = await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{ providerId: "boxd", apiKey: "old-key" },
					1,
				),
			);
			const id = required(first.connections[0]).connectionId;
			await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{ providerId: "boxd", apiKey: "new-key" },
					2,
				),
			);
			const active = required(
				(await runtime.runPromise(accountSandboxProviders("alice"))).find(
					(provider) => provider.providerId === "boxd",
				),
			);
			expect(active.connectionId).not.toBe(id);
			await runtime.runPromise(active.pause("sandbox"));
			await runtime.runPromise(
				storage.disconnect("alice", required(active.connectionId)),
			);
			const retained = await runtime.runPromise(
				resolveResourceProvider(build(id)),
			);
			await runtime.runPromise(retained.pause("sandbox"));
			expect(calls).toEqual(["new-key", "old-key"]);
			for (const [account, provider, connection] of [
				["bob", "boxd", id],
				["alice", "e2b", id],
				["alice", "boxd", "missing"],
			]) {
				await expect(
					runtime.runPromise(
						resolveConnectedProvider(
							required(account),
							required(provider),
							connection,
						),
					),
				).rejects.toMatchObject({
					code: "cloud_provider_connection_unavailable",
				});
			}
		} finally {
			await runtime.dispose();
		}
	});
	test("invalid replacements leave the old key active", async () => {
		const { runtime } = setup();
		try {
			await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{ providerId: "boxd", apiKey: "valid" },
					1,
				),
			);
			await expect(
				runtime.runPromise(
					saveProviderConnection(
						"alice",
						{ providerId: "boxd", apiKey: "invalid" },
						2,
					),
				),
			).rejects.toMatchObject({
				code: "cloud_provider_key_verification_failed",
			});
			expect(
				(await runtime.runPromise(listProviderConnections("alice"))).filter(
					(record) => record.active,
				),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});
	test("encrypted keys cannot be copied to another account or connection", async () => {
		const { runtime, records } = setup();
		try {
			const response = await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{ providerId: "boxd", apiKey: "secret" },
					1,
				),
			);
			const record = required(
				records.get(required(response.connections[0]).connectionId),
			);
			records.set("copied", {
				...record,
				connectionId: "copied",
				accountId: "bob",
			});
			await expect(
				runtime.runPromise(resolveConnectedProvider("bob", "boxd", "copied")),
			).rejects.toMatchObject({ code: "api_content_open_failed" });
		} finally {
			await runtime.dispose();
		}
	});
	test("BYOK bypasses reservations and settlement even when Zuse billing is enforced", async () => {
		const { runtime } = setup();
		try {
			const response = await runtime.runPromise(
				saveProviderConnection(
					"alice",
					{ providerId: "boxd", apiKey: "secret" },
					1,
				),
			);
			const id = required(response.connections[0]).connectionId;
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(store.saveBuild(build(id)));
			expect(
				await runtime.runPromise(cloudBillingCapacity("alice", 60_000, id)),
			).toBe("available");
			expect(
				await runtime.runPromise(cloudBillingCapacity("alice", 60_000)),
			).toBe("period-missing");
			expect(
				await runtime.runPromise(
					reserveProviderCost({
						accountId: "alice",
						resourceKind: "build",
						resourceId: "build",
						provider: "boxd",
						providerSandboxId: "sandbox",
						nowMs: 60_000,
						vcpuCount: 2,
						memoryMib: 8192,
					}),
				),
			).toBe(false);
			expect(
				await runtime.runPromise(
					meterProviderExecution({
						evidence: {
							provider: "boxd",
							eventId: "usage",
							internalResourceId: "build",
							startedAtMs: 1,
							endedAtMs: 60_000,
							vcpuCount: 2,
							memoryMib: 8192,
						},
						nowMs: 60_000,
					}),
				),
			).toEqual({ metered: false, reason: "provider-billed" });
		} finally {
			await runtime.dispose();
		}
	});
});
