import {
	type ModelConnection,
	ModelConnectionError,
	type ModelSignInEvent,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { resolveAccountApiUrl } from "../api/api-url.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import type { CredentialsServiceShape } from "../provider/services/credentials-service.ts";
import {
	type AccountConnectionTransport,
	accountConnectionVault,
	connectionStorageRequest,
	RuntimeModelConnections,
} from "./account-vault.ts";
import { ChatGPTOAuth } from "./chatgpt-oauth.ts";
import {
	type ModelConnectionsShape,
	makeModelConnections,
} from "./connections-service.ts";
import { GrokOAuth, XAI_PUBLIC_CLIENT_ID } from "./grok-oauth.ts";
import { modelConnectionVault } from "./vault.ts";

interface AccountService {
	accountId: string;
	service: ModelConnectionsShape;
}
const sharedId = (accountId: string, id: string) =>
	`account:${encodeURIComponent(accountId)}:${id}`;
const metadata = (
	accountId: string,
	value: ModelConnection,
): ModelConnection => ({
	...value,
	id: sharedId(accountId, value.id),
	storage: "account",
});
export const accountModelConnections = (
	credentials: CredentialsServiceShape,
	userData: string,
	cloud: boolean,
) =>
	Effect.gen(function* () {
		const identity = yield* AuthService;
		const runtime = yield* RuntimeModelConnections;
		let cached: {
			transport: AccountConnectionTransport;
			key: string;
			result: AccountService;
			close: () => void;
		} | null = null;
		const clear = () => {
			cached?.close();
			cached = null;
		};
		yield* Effect.addFinalizer(() => Effect.sync(clear));
		const factory = async (): Promise<AccountService | null> => {
			let transport: AccountConnectionTransport | null = null;
			let key = "";
			if (cloud) {
				transport = runtime.current;
				key = transport?.accountId ?? "";
			} else {
				const session = await Effect.runPromise(identity.getSession());
				const apiUrl = resolveAccountApiUrl();
				if (session._tag === "SignedIn") {
					const accountId = session.session.user.id;
					key = `${apiUrl}:${accountId}`;
					transport = {
						accountId,
						request: async (body) => {
							const current = await Effect.runPromise(identity.getSession());
							if (
								current._tag !== "SignedIn" ||
								current.session.user.id !== accountId ||
								resolveAccountApiUrl() !== apiUrl
							)
								throw new ModelConnectionError({ code: "unavailable" });
							return connectionStorageRequest(
								`${apiUrl}/v1/model-connections/storage`,
								{
									authorization: `Bearer ${await Effect.runPromise(identity.getAccessToken())}`,
								},
								body,
							);
						},
					};
				}
			}
			if (!transport) {
				clear();
				return null;
			}
			if (cached?.key === key && (!cloud || cached.transport === transport))
				return cached.result;
			clear();
			const hostId = modelConnectionVault(credentials, userData).hostId;
			const auth = new ChatGPTOAuth(
				accountConnectionVault(transport, "chatgpt", hostId),
			);
			const grok = new GrokOAuth(
				accountConnectionVault(transport, "supergrok", hostId),
				process.env.ZUSE_XAI_OAUTH_CLIENT_ID ?? XAI_PUBLIC_CLIENT_ID,
			);
			const result = {
				accountId: transport.accountId,
				service: makeModelConnections(auth, true, grok, !cloud),
			};
			cached = {
				transport,
				key,
				result,
				close: () => {
					auth.close();
					grok.close();
				},
			};
			return result;
		};
		return () =>
			Effect.tryPromise({
				try: factory,
				catch: () => new ModelConnectionError({ code: "storage_failed" }),
			});
	});

/** A shared connection is always resolved against the current Zuse account. */
export function combineModelConnections(
	local: ModelConnectionsShape,
	account: () => Effect.Effect<AccountService | null, ModelConnectionError>,
): ModelConnectionsShape {
	const resolve = (id: string) =>
		Effect.gen(function* () {
			if (!id.startsWith("account:")) return { service: local, id };
			const current = yield* account();
			if (!current)
				return yield* Effect.fail(
					new ModelConnectionError({ code: "unavailable" }),
				);
			const prefix = sharedId(current.accountId, "");
			if (!id.startsWith(prefix))
				return yield* Effect.fail(
					new ModelConnectionError({ code: "unknown_registration" }),
				);
			return { service: current.service, id: id.slice(prefix.length) };
		});
	const operation = <A>(
		id: string,
		run: (
			service: ModelConnectionsShape,
			id: string,
		) => Effect.Effect<A, ModelConnectionError>,
	) => Effect.flatMap(resolve(id), (target) => run(target.service, target.id));
	return {
		status: () =>
			Effect.gen(function* () {
				const status = yield* local.status();
				const shared = yield* Effect.gen(function* () {
					const target = yield* account();
					if (!target) return null;
					const remote = yield* target.service.status();
					return {
						...remote,
						connections: remote.connections.map((row) =>
							metadata(target.accountId, row),
						),
					};
				}).pipe(Effect.catch(() => Effect.succeed("error" as const)));
				return {
					...status,
					localAvailable: status.available,
					available:
						status.available || (shared !== null && shared !== "error"),
					accountAvailable: shared !== null && shared !== "error",
					accountError: shared === "error",
					chatgptAvailable:
						status.available ||
						(shared !== null &&
							shared !== "error" &&
							shared.chatgptAvailable === true),
					supergrokAvailable:
						status.supergrokAvailable ||
						(shared !== null &&
							shared !== "error" &&
							shared.supergrokAvailable),
					connections: [
						...status.connections,
						...(shared && shared !== "error" ? shared.connections : []),
					],
				};
			}),
		connect: (id, provider, storage = "local") =>
			Stream.unwrap(
				Effect.gen(function* () {
					const shared = storage === "account" || id?.startsWith("account:");
					if (!shared) return local.connect(id, provider);
					const target = yield* account();
					if (!target)
						return yield* Effect.fail(
							new ModelConnectionError({ code: "unavailable" }),
						);
					const resolved = id
						? yield* resolve(id)
						: { service: target.service, id: undefined };
					return resolved.service.connect(resolved.id, provider).pipe(
						Stream.map(
							(event): ModelSignInEvent =>
								event._tag === "connected"
									? {
											...event,
											connection: metadata(target.accountId, event.connection),
										}
									: event,
						),
					);
				}),
			),
		credential: (id) =>
			operation(id, (service, raw) => service.credential(raw)).pipe(
				Effect.map((value) => ({ ...value, connectionId: id })),
			),
		rename: (id, name) =>
			operation(id, (service, raw) => service.rename(raw, name)),
		preferred: (id) => operation(id, (service, raw) => service.preferred(raw)),
		disconnect: (id) =>
			operation(id, (service, raw) => service.disconnect(raw)),
		acknowledgePlan: (id) =>
			operation(id, (service, raw) => service.acknowledgePlan(raw)),
	};
}
