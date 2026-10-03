import { EnvironmentVaultResult } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import {
	EnvironmentVaultStore,
	environmentVaultOwner,
	loadEnvironmentVault,
	resolveEnvironmentVault,
	routeEnvironmentVaultRequest,
	type VaultRow,
} from "../../src/environment-vault.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
function harness() {
	const rows = new Map<string, VaultRow>();
	const audit: string[] = [];
	const layer = Layer.mergeAll(
		Config.layer({
			apiIssuer: "https://api.test",
			workosIssuer: "https://unused",
			workosJwksUrl: "https://unused/jwks",
			mintPrivateKey: Redacted.make("{}"),
			mintPublicKey: "{}",
			environmentVaultEnabled: true,
			cloudDataEncryptionKey: Redacted.make(
				"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			),
		}),
		CloudWorkspaceStoreMemory,
		WorkosVerifierTest,
		Layer.succeed(EnvironmentVaultStore, {
			purge: () => Effect.void,
			load: (owner) => Effect.succeed(rows.get(owner) ?? null),
			audit: (_owner, event) =>
				Effect.sync(() => {
					audit.push(event);
				}),
			commit: (owner, previous, ciphertext, event) =>
				Effect.sync(() => {
					if ((rows.get(owner)?.revision ?? 0) !== previous) return false;
					rows.set(owner, { revision: previous + 1, ciphertext });
					audit.push(event);
					return true;
				}),
		}),
	);
	const runtime = ManagedRuntime.make(layer);
	disposers.push(() => runtime.dispose());
	const request = async (body: unknown, account = "a") => {
		const response = await runtime.runPromise(
			routeEnvironmentVaultRequest(
				new Request("https://api.test/v1/environment-vault", {
					method: "POST",
					headers: {
						authorization: `Bearer test-token:${account}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			),
		);
		if (!response) throw new Error("No response");
		expect(response.headers.get("cache-control")).toBe("no-store");
		return Schema.decodeUnknownSync(EnvironmentVaultResult)(
			await response.json(),
		);
	};
	return { rows, audit, runtime, request };
}
describe("account environment vault", () => {
	test("encrypts values, lists metadata only, isolates accounts, and resolves by project", async () => {
		const h = harness();
		const project = await h.request({
			action: "project",
			name: "Project A",
			expectedRevision: 0,
		});
		const saved = await h.request({
			action: "save",
			expectedRevision: 1,
			entry: {
				id: "",
				name: "DATABASE_URL",
				kind: "secret",
				scope: "personal",
				projectIds: null,
				excludedProjectIds: [],
				target: "both",
				revision: 0,
				updatedAt: 0,
			},
			value: "private-database-value",
		});
		expect(JSON.stringify(saved)).not.toContain("private-database-value");
		expect(JSON.stringify([...h.rows.values()])).not.toContain(
			"private-database-value",
		);
		expect((await h.request({ action: "list" }, "b")).snapshot.entries).toEqual(
			[],
		);
		const resolved = await h.runtime.runPromise(
			resolveEnvironmentVault(
				environmentVaultOwner("a"),
				project.projectId ?? "",
				"cloud",
			),
		);
		expect(resolved.values.DATABASE_URL).toBe("private-database-value");
		expect(resolved.secretNames).toEqual(["DATABASE_URL"]);
		const id = saved.snapshot.entries[0]?.id;
		expect((await h.request({ action: "reveal", id })).value).toBe(
			"private-database-value",
		);
		await expect(
			h.request({ action: "reveal", id }, "b"),
		).rejects.toBeDefined();
		expect(h.audit.join("\n")).not.toContain("private-database-value");
		expect(h.audit.some((event) => event.includes('"reveal"'))).toBe(true);
		const ciphertextBefore = h.rows.get(environmentVaultOwner("a"))?.ciphertext;
		const rotated = await h.request({
			action: "rotate",
			expectedRevision: saved.snapshot.revision,
		});
		expect(rotated.snapshot.revision).toBe(saved.snapshot.revision + 1);
		expect(h.rows.get(environmentVaultOwner("a"))?.ciphertext).not.toBe(
			ciphertextBefore,
		);
		expect((await h.request({ action: "reveal", id })).value).toBe(
			"private-database-value",
		);
	});
	test("rejects stale writes, tampered owner bindings, team writes, and unregistered projects", async () => {
		const h = harness();
		await h.request({
			action: "project",
			name: "Project",
			expectedRevision: 0,
		});
		await expect(
			h.request({ action: "project", name: "Stale", expectedRevision: 0 }),
		).rejects.toBeDefined();
		await expect(
			h.runtime.runPromise(
				resolveEnvironmentVault(
					environmentVaultOwner("a"),
					"unregistered",
					"local",
				),
			),
		).rejects.toBeDefined();
		const row = h.rows.get(environmentVaultOwner("a"));
		if (!row) throw new Error("Missing fixture row");
		h.rows.set(environmentVaultOwner("b"), row);
		await expect(
			h.runtime.runPromise(loadEnvironmentVault(environmentVaultOwner("b"))),
		).rejects.toBeDefined();
		await expect(
			h.request({
				action: "save",
				expectedRevision: 1,
				entry: {
					id: "",
					name: "TOKEN",
					kind: "secret",
					scope: "team",
					projectIds: null,
					excludedProjectIds: [],
					target: "both",
					revision: 0,
					updatedAt: 0,
				},
				value: "secret",
			}),
		).rejects.toBeDefined();
	});
	test("organization personal values never cross account or organization context", async () => {
		const h = harness();
		await h.request(
			{ action: "project", name: "Private", expectedRevision: 0 },
			"a:org",
		);
		expect(
			(await h.request({ action: "list" }, "a")).snapshot.projects,
		).toEqual([]);
		expect(
			(await h.request({ action: "list" }, "b:org")).snapshot.projects,
		).toEqual([]);
	});
});
