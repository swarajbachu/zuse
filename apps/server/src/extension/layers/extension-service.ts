import { join } from "node:path";
import { ExtensionError, ProviderId } from "@zuse/contracts";
import { ExtensionHost, ProviderEventHub } from "@zuse/extension-host";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";
import { AppPaths } from "../../app-paths.ts";
import { CredentialsService } from "../../provider/services/credentials-service.ts";
import {
	EXTENSION_MARKETPLACE_CATALOG_URL,
	EXTENSION_MARKETPLACE_PUBLIC_KEY,
	EXTENSION_MARKETPLACE_SIGNATURE_URL,
} from "../marketplace-config.ts";
import { ExtensionService } from "../services/extension-service.ts";

export const ExtensionServiceLive = Layer.effect(
	ExtensionService,
	Effect.gen(function* () {
		const attempt = <A>(run: () => Promise<A>) =>
			Effect.tryPromise({
				try: run,
				catch: (cause) =>
					cause instanceof ExtensionError
						? cause
						: new ExtensionError({
								code: "rpc-failed",
								extensionId: null,
								reason: cause instanceof Error ? cause.message : String(cause),
							}),
			});
		const { userData, telemetryIdentity } = yield* AppPaths;
		const supported = telemetryIdentity?.kind === "desktop";
		const credentials = yield* CredentialsService;
		const changes =
			yield* PubSub.unbounded<ReturnType<ExtensionHost["snapshot"]>>();
		const eventHub = new ProviderEventHub();
		const runtime = yield* Effect.context<never>();
		const host = new ExtensionHost({
			rootDirectory: join(userData, "extensions"),
			marketplace: {
				catalogUrl: EXTENSION_MARKETPLACE_CATALOG_URL,
				signatureUrl: EXTENSION_MARKETPLACE_SIGNATURE_URL,
				publicKeyPem: EXTENSION_MARKETPLACE_PUBLIC_KEY,
			},
			secretStore: {
				get: (extensionId, key) => {
					if (key.startsWith("provider:")) {
						const providerId = Schema.decodeUnknownSync(ProviderId)(
							key.slice("provider:".length),
						);
						return Effect.runPromiseWith(runtime)(
							credentials
								.getProviderCredential(providerId)
								.pipe(Effect.map((credential) => credential?.secret ?? null)),
						);
					}
					return Effect.runPromiseWith(runtime)(
						credentials.getIntegration("extension", `${extensionId}:${key}`),
					);
				},
				set: (extensionId, key, value) =>
					Effect.runPromiseWith(runtime)(
						credentials.setIntegration(
							"extension",
							`${extensionId}:${key}`,
							value,
						),
					),
				delete: async (extensionId, key) => {
					if (key !== "*") {
						await Effect.runPromiseWith(runtime)(
							credentials.removeIntegration(
								"extension",
								`${extensionId}:${key}`,
							),
						);
						return;
					}
					const accounts = await Effect.runPromiseWith(runtime)(
						credentials.listIntegrationAccounts("extension"),
					);
					await Promise.all(
						accounts
							.filter((account) => account.startsWith(`${extensionId}:`))
							.map((account) =>
								Effect.runPromiseWith(runtime)(
									credentials.removeIntegration("extension", account),
								),
							),
					);
				},
			},
		});
		const unsubscribe = host.subscribe((catalog) => {
			Effect.runFork(PubSub.publish(changes, catalog));
		});
		const unsubscribeProviderEvents = host.subscribeProviderEvents(
			(sessionId, event) => eventHub.push(sessionId, event),
		);
		let started: Promise<void> | null = null;
		const ensureStarted = () => {
			if (!supported) return Promise.resolve();
			started ??= host.start({ background: true }).catch((cause) => {
				console.error("[extensions] startup failed", cause);
			});
			return started;
		};
		const requireSupported = () => {
			if (!supported)
				throw new ExtensionError({
					code: "unsupported-environment",
					extensionId: null,
					reason:
						"Extensions Preview is available on the local desktop host only.",
				});
		};
		yield* Effect.addFinalizer(() =>
			Effect.promise(async () => {
				unsubscribe();
				unsubscribeProviderEvents();
				eventHub.stop();
				await started;
				await host.stop();
			}),
		);
		return ExtensionService.of({
			catalog: () =>
				Effect.promise(async () => {
					await ensureStarted();
					return host.snapshot();
				}),
			stream: () =>
				Stream.concat(
					Stream.fromEffect(
						Effect.promise(async () => {
							await ensureStarted();
							return host.snapshot();
						}),
					),
					Stream.fromPubSub(changes),
				),
			inspect: (source) =>
				attempt(async () => {
					requireSupported();
					await ensureStarted();
					return host.inspect(source);
				}),
			execute: (command) =>
				attempt(async () => {
					requireSupported();
					await ensureStarted();
					return host.execute(command);
				}),
			cancel: (id, requestId) =>
				attempt(async () => {
					requireSupported();
					host.cancel(id, requestId);
				}),
			invoke: (id, method, input, workspace, requestId) =>
				attempt(() => {
					requireSupported();
					return host.invoke(id, method, input, workspace, requestId);
				}),
			logs: (id) =>
				Effect.try({
					try: () => host.logs(id),
					catch: (cause) =>
						cause instanceof ExtensionError
							? cause
							: new ExtensionError({
									code: "rpc-failed",
									extensionId: id,
									reason: String(cause),
								}),
				}),
			marketplace: (refresh) => attempt(() => host.marketplace(refresh)),
			providers: () => Effect.sync(() => host.providerDescriptors()),
			invokeProvider: (providerId, operation, input) =>
				attempt(async () => {
					const value = input as {
						sessionId?: string;
						input?: { sessionId?: string };
					};
					const sessionId = value.sessionId ?? value.input?.sessionId;
					if (operation === "start" && sessionId) eventHub.open(sessionId);
					try {
						return await host.invokeProvider(providerId, operation, input);
					} catch (cause) {
						if (operation === "start" && sessionId) eventHub.close(sessionId);
						throw cause;
					} finally {
						if (operation === "close" && sessionId) eventHub.close(sessionId);
					}
				}),
			providerEvents: (sessionId) =>
				Stream.fromAsyncIterable(
					eventHub.stream(sessionId),
					(cause) => new Error(String(cause)),
				).pipe(Stream.orDie),
		});
	}),
);
