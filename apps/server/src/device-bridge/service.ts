import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
	DeviceBridgeAction,
	DeviceCommand,
	DeviceCommandGrant,
} from "@zuse/contracts";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { importJWK, jwtVerify } from "jose";
import { AuthService } from "../auth/services/auth-service.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { DeviceCommandBroker, type DevicePrincipal } from "./broker.ts";

export class DeviceBridgeService extends Context.Service<
	DeviceBridgeService,
	{
		readonly broker: DeviceCommandBroker;
		readonly receive: (token: string, body: string) => Promise<unknown>;
	}
>()("zuse/DeviceBridgeService") {}
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
export const DeviceBridgeServiceLive = Layer.effect(
	DeviceBridgeService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const auth = yield* LanAuthService;
		const account = yield* AuthService;
		const run = Effect.runPromise;
		const decodeCommand = Schema.decodeUnknownSync(
			Schema.fromJsonString(DeviceCommand),
		);
		const decodeGrant = Schema.decodeUnknownSync(
			Schema.fromJsonString(DeviceCommandGrant),
		);
		const broker = new DeviceCommandBroker(
			{
				loadConfig: async () => {
					const [row] = await run(
						sql<{
							link_key: string;
							enabled: number;
						}>`SELECT * FROM device_bridge_config WHERE id = 1`,
					);
					return row
						? { linkKey: row.link_key, enabled: row.enabled === 1 }
						: null;
				},
				saveConfig: async (key, enabled) => {
					await run(
						sql`INSERT INTO device_bridge_config(id, link_key, enabled) VALUES(1, ${key}, ${enabled ? 1 : 0}) ON CONFLICT(id) DO UPDATE SET link_key=excluded.link_key, enabled=excluded.enabled`,
					);
				},
				commands: async () =>
					(
						await run(
							sql<{
								payload: string;
							}>`SELECT payload FROM device_commands WHERE state IN ('pending', 'running') UNION ALL SELECT payload FROM (SELECT payload FROM device_commands WHERE state NOT IN ('pending', 'running') ORDER BY created_at DESC LIMIT 20)`,
						)
					).map((row) => decodeCommand(row.payload)),
				command: async (id) => {
					const [row] = await run(
						sql<{
							payload: string;
						}>`SELECT payload FROM device_commands WHERE id=${id}`,
					);
					return row ? decodeCommand(row.payload) : undefined;
				},
				reserveCommand: async (command) =>
					(
						await run(
							sql`INSERT INTO device_commands(id,state,created_at,payload) VALUES(${command.id},${command.state},${command.createdAt},${JSON.stringify(command)}) ON CONFLICT(id) DO NOTHING RETURNING id`,
						)
					).length === 1,
				saveCommand: async (command) => {
					await run(
						sql`INSERT INTO device_commands(id,state,created_at,payload) VALUES(${command.id},${command.state},${command.createdAt},${JSON.stringify(command)}) ON CONFLICT(id) DO UPDATE SET state=excluded.state, payload=excluded.payload`,
					);
				},
				grants: async () =>
					(
						await run(
							sql<{
								payload: string;
							}>`SELECT payload FROM device_command_grants`,
						)
					).map((row) => decodeGrant(row.payload)),
				saveGrant: async (grant) => {
					await run(
						sql`INSERT INTO device_command_grants(id,payload) VALUES(${grant.id},${JSON.stringify(grant)}) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
					);
				},
				deleteGrant: async (id) => {
					await run(sql`DELETE FROM device_command_grants WHERE id=${id}`);
				},
				clearGrants: async () => {
					await run(sql`DELETE FROM device_command_grants`);
				},
			},
			async () => {
				const config = await run(auth.getApiConfig());
				const session = await run(account.getSession());
				return {
					linkKey: config
						? hash(config.environmentCredential) +
							(session._tag === "SignedIn"
								? session.session.user.id
								: "signed-out")
						: "",
					deviceId: await run(auth.environmentId()),
					deviceName: config?.label ?? "This computer",
					homeDirectory: homedir(),
					connected:
						session._tag === "SignedIn" &&
						Boolean(config?.tunnelHostname && config.mintPublicKey) &&
						!process.env.ZUSE_CLOUD_WORKSPACE_ID,
				};
			},
		);
		yield* Effect.promise(() => broker.initialize());
		yield* Effect.addFinalizer(() => Effect.sync(() => broker.close()));
		const initialAccount = yield* account.getSession();
		let accountId =
			initialAccount._tag === "SignedIn"
				? initialAccount.session.user.id
				: null;
		yield* account.sessionChanges().pipe(
			Stream.runForEach((state) => {
				const nextId = state._tag === "SignedIn" ? state.session.user.id : null;
				const changed = nextId !== accountId || nextId === null;
				accountId = nextId;
				return changed
					? Effect.promise(() => broker.configure(false)).pipe(Effect.asVoid)
					: Effect.void;
			}),
			Effect.forkScoped({ startImmediately: true }),
		);
		return {
			broker,
			receive: async (token, body) => {
				const config = await run(auth.getApiConfig());
				if (!config?.mintPublicKey) throw new Error("Device is not linked");
				const { payload, protectedHeader } = await jwtVerify(
					token,
					await importJWK(JSON.parse(config.mintPublicKey), "EdDSA"),
					{
						algorithms: ["EdDSA"],
						issuer: config.apiIssuer,
						audience: `device-bridge:${config.environmentId}`,
						maxTokenAge: "20s",
					},
				);
				if (
					protectedHeader.typ !== "device-bridge+jwt" ||
					payload.bodyHash !== hash(body)
				)
					throw new Error("Invalid bridge request");
				for (const key of ["accountId", "workspaceId", "chatId", "sessionId"])
					if (typeof payload[key] !== "string" || !payload[key])
						throw new Error("Invalid bridge identity");
				if (
					!Number.isSafeInteger(payload.grantEpoch) ||
					Number(payload.grantEpoch) < 0
				)
					throw new Error("Invalid grant epoch");
				if (payload.actor !== "runtime" && payload.actor !== "user")
					throw new Error("Invalid bridge actor");
				const session = await run(account.getSession());
				if (
					session._tag !== "SignedIn" ||
					session.session.user.id !== payload.accountId
				)
					throw new Error("Account mismatch");
				const action = Schema.decodeUnknownSync(
					Schema.fromJsonString(DeviceBridgeAction),
				)(body);
				return broker.handle(action, {
					accountId: payload.accountId,
					workspaceId: payload.workspaceId,
					chatId: payload.chatId,
					chatTitle:
						typeof payload.chatTitle === "string"
							? payload.chatTitle
							: payload.chatId,
					sessionId: payload.sessionId,
					grantEpoch: payload.grantEpoch,
					actor: payload.actor,
				} as DevicePrincipal);
			},
		};
	}),
);
