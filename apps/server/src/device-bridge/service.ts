import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
	DeviceBridgeAction,
	DeviceCommand,
	DeviceCommandGrant,
} from "@zuse/contracts";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { importJWK, jwtVerify } from "jose";
import { resolveAccountApiUrl } from "../api/api-url.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import { defaultEnvironmentLabel } from "../lan-auth/environment-label.ts";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { DeviceCommandBroker, type DevicePrincipal } from "./broker.ts";
import {
	type BridgeChannelConnection,
	DesktopBridgeChannel,
	type DesktopBridgeChannelOptions,
} from "./channel.ts";

export class DeviceBridgeChannelFactory extends Context.Service<
	DeviceBridgeChannelFactory,
	{ make: (options: DesktopBridgeChannelOptions) => BridgeChannelConnection }
>()("zuse/DeviceBridgeChannelFactory") {}

export class DeviceBridgeService extends Context.Service<
	DeviceBridgeService,
	{
		readonly broker: DeviceCommandBroker;
		readonly setEnabled: (enabled: boolean) => Promise<void>;
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
		const deviceId = yield* auth.environmentId();

		const deviceName = yield* defaultEnvironmentLabel();
		const apiUrl = resolveAccountApiUrl();
		let enabled = true;
		let channel: BridgeChannelConnection | undefined;
		const factory = yield* Effect.serviceOption(DeviceBridgeChannelFactory);
		const enrollmentFor = async (accountId: string) => {
			await run(
				sql`INSERT INTO device_bridge_enrollment(account_id, secret, enabled) VALUES(${accountId}, ${randomBytes(32).toString("hex")}, 1) ON CONFLICT(account_id) DO NOTHING`,
			);
			const [row] = await run(
				sql<{
					secret: string;
					enabled: number;
				}>`SELECT secret, enabled FROM device_bridge_enrollment WHERE account_id=${accountId}`,
			);
			if (!row) throw new Error("Missing bridge enrollment");
			return row;
		};

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
						}>`SELECT link_key FROM device_bridge_config WHERE id = 1`,
					);
					return row ? { linkKey: row.link_key } : null;
				},
				saveConfig: async (key) => {
					await run(
						sql`INSERT INTO device_bridge_config(id, link_key, enabled) VALUES(1, ${key}, 1) ON CONFLICT(id) DO UPDATE SET link_key=excluded.link_key, enabled=excluded.enabled`,
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
				const session = await run(account.getSession());
				const id = session._tag === "SignedIn" ? session.session.user.id : null;
				const enrollment = id ? await enrollmentFor(id) : null;
				enabled =
					enrollment?.enabled === 1 && !process.env.ZUSE_CLOUD_WORKSPACE_ID;
				return {
					linkKey: id && enrollment ? hash(enrollment.secret) + id : "",
					accountId: id,
					deviceId,
					deviceName,
					homeDirectory: homedir(),
					enabled,
					connectionError: channel?.snapshot().error,
					connected:
						enabled &&
						channel?.snapshot().connected === true &&
						channel.snapshot().accountId === id,
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
				if (changed) channel?.start();
				accountId = nextId;
				return changed
					? Effect.promise(() => broker.invalidate()).pipe(Effect.asVoid)
					: Effect.void;
			}),
			Effect.forkScoped({ startImmediately: true }),
		);
		const receive = async (
			token: string,
			body: string,
			config: { mintPublicKey: string; apiIssuer: string },
		) => {
			const { payload, protectedHeader } = await jwtVerify(
				token,
				await importJWK(JSON.parse(config.mintPublicKey), "EdDSA"),
				{
					algorithms: ["EdDSA"],
					issuer: config.apiIssuer,
					audience: `device-bridge:${deviceId}`,
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
		};
		channel = (
			Option.isSome(factory)
				? factory.value.make
				: (options: DesktopBridgeChannelOptions) =>
						new DesktopBridgeChannel(options)
		)({
			apiUrl,
			receive,
			identity: async () => {
				if (process.env.ZUSE_CLOUD_WORKSPACE_ID) return null;
				const session = await run(account.getSession());
				if (session._tag !== "SignedIn") return null;
				const accountId = session.session.user.id;
				const enrollment = await enrollmentFor(accountId);
				if (enrollment.enabled !== 1) return null;
				return {
					accountId,
					deviceId,
					label: deviceName,
					secret: enrollment.secret,
					token: await run(account.getAccessToken()),
				};
			},
		});
		channel.start();
		yield* Effect.addFinalizer(() => Effect.sync(() => channel?.stop()));
		return {
			broker,
			setEnabled: async (next: boolean) => {
				const session = await run(account.getSession());
				if (session._tag !== "SignedIn")
					throw new Error("Sign in to manage cloud device access");
				const accountId = session.session.user.id;
				const enrollment = await enrollmentFor(accountId);
				// Local off takes effect even when the API is unreachable.
				if (!next)
					await run(
						sql`UPDATE device_bridge_enrollment SET enabled=0 WHERE account_id=${accountId}`,
					);
				channel?.stop();
				await broker.invalidate();
				const token = await run(account.getAccessToken());
				if (next) {
					const response = await fetch(`${apiUrl}/v1/device-bridge/enroll`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							deviceId,
							label: deviceName,
							secret: enrollment.secret,
							restore: true,
						}),
						signal: AbortSignal.timeout(8000),
					});
					if (!response.ok)
						throw new Error("Could not enable cloud device access");
					const current = await run(account.getSession());
					if (
						current._tag !== "SignedIn" ||
						current.session.user.id !== accountId
					)
						throw new Error("Account changed");
					await run(
						sql`UPDATE device_bridge_enrollment SET enabled=1 WHERE account_id=${accountId}`,
					);
					channel?.start();
				} else {
					await fetch(
						`${apiUrl}/v1/device-bridge/revoke?deviceId=${encodeURIComponent(deviceId)}`,
						{
							method: "POST",
							headers: { authorization: `Bearer ${token}` },
							signal: AbortSignal.timeout(8000),
						},
					).catch(() => undefined);
				}
			},
			// Legacy public tunnel ingress is intentionally disabled.
			receive: async () => {
				throw new Error("Device bridge requires the independent channel");
			},
		};
	}),
);
