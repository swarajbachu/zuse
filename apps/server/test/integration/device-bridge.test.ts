import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthState, EnvironmentId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, PubSub, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import { CloudDeviceCommandClient } from "../../src/device-bridge/cloud-client.ts";
import {
	DeviceBridgeService,
	DeviceBridgeServiceLive,
} from "../../src/device-bridge/service.ts";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

it.each([
	"fresh",
	"other-branch",
	"previous-bridge",
])("boots %s databases and runs approved commands with durable receipts", async (databaseState) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-device-integration-"));
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const apiConfig = {
		apiUrl: "https://api.test",
		apiIssuer: "https://api.test",
		environmentId: EnvironmentId.make("desktop"),
		environmentCredential: "zenv_secret",
		label: "Test Mac",
		connectorToken: "test",
		tunnelHostname: "desktop.test",
		mintPublicKey: JSON.stringify(await exportJWK(keys.publicKey)),
	};
	const sql = sqliteLayer({ filename: join(directory, "state.sqlite") });
	const migratedSql = sql.pipe(
		Layer.provideMerge(MigrationsLive.pipe(Layer.provide(sql))),
	);
	if (databaseState !== "fresh") {
		const setup = ManagedRuntime.make(migratedSql);
		try {
			await setup.runPromise(
				Effect.gen(function* () {
					const client = yield* SqlClient.SqlClient;
					if (databaseState === "other-branch") {
						yield* client`DROP TABLE device_commands`;
						yield* client`DROP TABLE device_command_grants`;
						yield* client`DROP TABLE device_bridge_config`;
					}
					yield* client`DELETE FROM effect_sql_migrations WHERE migration_id >= 55`;
					const name =
						databaseState === "other-branch"
							? "staging_api_origin"
							: "device_bridge";
					yield* client`INSERT INTO effect_sql_migrations(migration_id, name) VALUES (55, ${name})`;
				}),
			);
		} finally {
			await setup.dispose();
		}
	}
	const accountChanges = await Effect.runPromise(PubSub.unbounded<AuthState>());
	const account = Layer.succeed(AuthService, {
		sessionChanges: () => Stream.fromPubSub(accountChanges),
		getSession: () =>
			Effect.succeed(
				Schema.decodeUnknownSync(AuthState)({
					_tag: "SignedIn",
					session: {
						user: {
							id: "account",
							email: "test@example.com",
							firstName: null,
							lastName: null,
							profilePictureUrl: null,
						},
						organizationId: null,
						expiresAt: Date.now() + 60000,
					},
				}),
			),
	} as AuthService["Service"]);
	const auth = Layer.succeed(LanAuthService, {
		getApiConfig: () => Effect.succeed(apiConfig),
		environmentId: () => Effect.succeed(apiConfig.environmentId),
	} as unknown as LanAuthService["Service"]);
	const makeRuntime = () =>
		ManagedRuntime.make(
			DeviceBridgeServiceLive.pipe(
				Layer.provide(migratedSql),
				Layer.provide(account),
				Layer.provide(auth),
			),
		);
	let runtime = makeRuntime();
	const sign = async (
		body: string,
		actor = "runtime",
		overrides: Record<string, unknown> = {},
		expired = false,
	) =>
		new SignJWT({
			accountId: "account",
			workspaceId: "workspace",
			chatId: "chat",
			sessionId: "session",
			grantEpoch: 0,
			actor,
			bodyHash: createHash("sha256").update(body).digest("hex"),
			...overrides,
		})
			.setProtectedHeader({ alg: "EdDSA", typ: "device-bridge+jwt" })
			.setIssuer("https://api.test")
			.setAudience("device-bridge:desktop")
			.setIssuedAt()
			.setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 1 : "15s")
			.sign(keys.privateKey);
	let service = await runtime.runPromise(DeviceBridgeService);
	const server = createServer(async (request, response) => {
		try {
			if (request.headers.authorization !== "Bearer cloud-runtime") {
				response.writeHead(401).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const actionBody = JSON.stringify(JSON.parse(body).action);
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					await service.receive(await sign(actionBody), actionBody),
				),
			);
		} catch {
			response.writeHead(403).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test listener");
	const client = new CloudDeviceCommandClient(
		`http://127.0.0.1:${address.port}`,
		() => "cloud-runtime",
	);
	try {
		expect((await service.broker.status()).enabled).toBe(true);
		const input = {
			id: "http-command",
			command: "printf local-output",
			cwd: directory,
		};
		expect(await client.request({ _tag: "execute", input })).toMatchObject({
			state: "pending",
			deviceName: "Test Mac",
		});
		const decision = JSON.stringify({
			_tag: "decide",
			id: input.id,
			decision: "AllowForSession",
		});
		await expect(
			service.receive(await sign(decision), decision),
		).rejects.toThrow("User approval");
		await service.receive(await sign(decision, "user"), decision);
		let completed = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const result = await client.request({ _tag: "poll", id: input.id });
			if ("state" in result && result.state === "completed") {
				expect(result.stdout).toBe("local-output");
				expect(result.exitCode).toBe(0);
				completed = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(completed).toBe(true);
		const status = JSON.stringify({ _tag: "status" });
		await expect(
			service.receive(
				await sign(status, "runtime", { accountId: "attacker" }),
				status,
			),
		).rejects.toThrow("Account mismatch");
		await expect(
			service.receive(
				await sign(status),
				JSON.stringify({ _tag: "cancel", id: input.id }),
			),
		).rejects.toThrow("Invalid bridge request");
		await expect(
			service.receive(await sign(status, "runtime", {}, true), status),
		).rejects.toThrow();
		await runtime.dispose();
		runtime = makeRuntime();
		service = await runtime.runPromise(DeviceBridgeService);
		expect((await service.broker.status()).grants).toHaveLength(1);
		expect(await client.request({ _tag: "execute", input })).toMatchObject({
			state: "completed",
			stdout: "local-output",
		});
		// Even if sign-in has already returned by the time the callback runs, the
		// intervening sign-out must revoke persistent grants.
		await Effect.runPromise(
			PubSub.publish(accountChanges, { _tag: "SignedOut" }),
		);
		await expect
			.poll(async () => (await service.broker.status()).grants.length)
			.toBe(0);
		expect((await service.broker.status()).enabled).toBe(true);
		expect(
			await client.request({
				_tag: "execute",
				input: { ...input, id: "after-sign-in" },
			}),
		).toMatchObject({ state: "pending" });
	} finally {
		client.close();
		await runtime.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
