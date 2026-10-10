import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLOUD_RUNTIME_IDENTITY_FILE,
	openCloudRuntimeIdentity,
} from "../../src/api/cloud-runtime-identity.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const fixture = async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-identity-"));
	directories.push(directory);
	const database = new DatabaseSync(join(directory, "zuse.sqlite"));
	database.exec(
		"CREATE TABLE sessions (id TEXT PRIMARY KEY, content TEXT); INSERT INTO sessions VALUES ('retained-session', 'retained message');",
	);
	database.close();
	return {
		directory,
		workspaceId: "workspace-1",
		apiUrl: "https://api.test",
		storageIncarnationId: "storage-1",
		bootToken: "boot-1",
		expectedGeneration: 4,
	};
};
const bootstrap = {
	zuseAccountId: "account-1",
	workspaceId: "workspace-1",
	runtimeGeneration: 4,
	runtimeCredential: "bearer-1",
	runtimeGatewayCredential: "gateway-1",
	runtimeCredentialExpiresAt: 10,
	gatewayEpoch: 2,
};

describe("durable workspace identity", () => {
	it("persists candidate keys before enrollment and replays identical keys after a lost response", async () => {
		const input = await fixture();
		const first = await openCloudRuntimeIdentity(input);
		const retry = await openCloudRuntimeIdentity(input);
		expect(retry.credentialPublicJwk).toBe(first.credentialPublicJwk);
		expect(retry.signingPublicJwk).toBe(first.signingPublicJwk);
		const proof = await new SignJWT({ workspaceId: input.workspaceId })
			.setProtectedHeader({ alg: "EdDSA" })
			.sign(retry.signingPrivateKey);
		await expect(
			jwtVerify(
				proof,
				await importJWK(JSON.parse(first.signingPublicJwk), "EdDSA"),
			),
		).resolves.toMatchObject({ payload: { workspaceId: input.workspaceId } });
		expect(
			(await stat(join(input.directory, CLOUD_RUNTIME_IDENTITY_FILE))).mode &
				0o777,
		).toBe(0o600);
		const database = new DatabaseSync(join(input.directory, "zuse.sqlite"), {
			readOnly: true,
		});
		expect(database.prepare("SELECT * FROM sessions").all()).toEqual([
			{ id: "retained-session", content: "retained message" },
		]);
		expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({
			integrity_check: "ok",
		});
		database.close();
	});

	it("restarts without a boot token with complete bootstrap/bearer and pending rotation ID", async () => {
		const input = await fixture();
		const first = await openCloudRuntimeIdentity(input);
		await first.commitBootstrap(bootstrap);
		await first.beginRenewal("rotation-1");
		const restarted = await openCloudRuntimeIdentity({
			...input,
			bootToken: undefined,
		});
		expect(restarted.bootstrap).toEqual(bootstrap);
		expect(await restarted.beginRenewal("wrong-new-id")).toBe("rotation-1");
		await restarted.commitRenewal({
			...bootstrap,
			runtimeCredential: "bearer-2",
			runtimeCredentialExpiresAt: 999,
		});
		const committed = await openCloudRuntimeIdentity({
			...input,
			bootToken: undefined,
		});
		expect(committed.pendingRenewalId).toBeNull();
		expect(committed.bootstrap).toMatchObject({
			runtimeCredential: "bearer-2",
		});
	});

	it("new authorized generation discards stale bearer but preserves durable keys", async () => {
		const input = await fixture();
		const first = await openCloudRuntimeIdentity(input);
		await first.commitBootstrap(bootstrap);
		await first.acknowledgeBootstrap();
		const next = await openCloudRuntimeIdentity({
			...input,
			bootToken: "boot-2",
			expectedGeneration: 5,
		});
		expect(next.bootstrap).toBeNull();
		expect(next.bootstrapAcknowledged).toBe(false);
		expect(next.signingPublicJwk).toBe(first.signingPublicJwk);
		await expect(
			next.commitBootstrap({ ...bootstrap, runtimeGeneration: 4 }),
		).rejects.toThrow("binding_mismatch");
		await next.commitBootstrap({ ...bootstrap, runtimeGeneration: 5 });
	});

	it("atomically merges bootstrap acknowledgment with concurrent rotation persistence without restoring the spent bearer", async () => {
		const input = await fixture();
		const identity = await openCloudRuntimeIdentity(input);
		await identity.commitBootstrap(bootstrap);
		await identity.beginRenewal("rotation-1");
		await Promise.all([
			identity.commitRenewal({ ...bootstrap, runtimeCredential: "new-bearer" }),
			identity.acknowledgeBootstrap(),
		]);
		const restart = await openCloudRuntimeIdentity({
			...input,
			bootToken: undefined,
		});
		expect(restart.bootstrapAcknowledged).toBe(true);
		expect(restart.pendingRenewalId).toBeNull();
		expect(restart.bootstrap).toMatchObject({
			runtimeCredential: "new-bearer",
		});
	});

	it.each([
		"workspace",
		"storage",
		"api",
		"generation",
	])("rejects a changed %s binding without overwriting the stored owner", async (field) => {
		const input = await fixture();
		const first = await openCloudRuntimeIdentity(input);
		await first.commitBootstrap(bootstrap);
		const before = await readFile(
			join(input.directory, CLOUD_RUNTIME_IDENTITY_FILE),
			"utf8",
		);
		const changed = {
			...input,
			bootToken: undefined,
			...(field === "workspace"
				? { workspaceId: "other" }
				: field === "storage"
					? { storageIncarnationId: "other" }
					: field === "api"
						? { apiUrl: "https://other.test" }
						: { expectedGeneration: 5 }),
		};
		await expect(openCloudRuntimeIdentity(changed)).rejects.toThrow("mismatch");
		expect(
			await readFile(
				join(input.directory, CLOUD_RUNTIME_IDENTITY_FILE),
				"utf8",
			),
		).toBe(before);
	});

	it("rejects an account switch even with a new launch token", async () => {
		const input = await fixture();
		const first = await openCloudRuntimeIdentity(input);
		await first.commitBootstrap(bootstrap);
		const next = await openCloudRuntimeIdentity({
			...input,
			bootToken: "boot-2",
		});
		await expect(
			next.commitBootstrap({ ...bootstrap, zuseAccountId: "other" }),
		).rejects.toThrow("binding_mismatch");
	});

	it("fails closed on missing/corrupt identity without bootstrap instead of initializing another owner", async () => {
		const input = await fixture();
		await expect(
			openCloudRuntimeIdentity({ ...input, bootToken: undefined }),
		).rejects.toThrow("identity_missing");
		await writeFile(
			join(input.directory, CLOUD_RUNTIME_IDENTITY_FILE),
			"corrupt",
		);
		await expect(openCloudRuntimeIdentity(input)).rejects.toThrow(
			"identity_unreadable",
		);
		const database = new DatabaseSync(join(input.directory, "zuse.sqlite"), {
			readOnly: true,
		});
		expect(database.prepare("SELECT * FROM sessions").all()).toEqual([
			{ id: "retained-session", content: "retained message" },
		]);
		expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({
			integrity_check: "ok",
		});
		database.close();
	});
});
