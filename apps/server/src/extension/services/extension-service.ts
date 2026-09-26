import type {
	ExtensionCatalog,
	ExtensionError,
	ExtensionLogEntry,
	ExtensionManifest,
	ExtensionProviderDescriptor,
	ExtensionSource,
	MarketplaceExtension,
} from "@zuse/contracts";
import type {
	ExtensionHostCommand,
	ExtensionHostCommandResult,
} from "@zuse/extension-host";
import { Context, type Effect, type Stream } from "effect";

export interface ExtensionServiceShape {
	readonly catalog: () => Effect.Effect<ExtensionCatalog>;
	readonly stream: () => Stream.Stream<ExtensionCatalog>;
	readonly inspect: (
		source: ExtensionSource,
	) => Effect.Effect<ExtensionManifest, ExtensionError>;
	readonly execute: (
		command: ExtensionHostCommand,
	) => Effect.Effect<ExtensionHostCommandResult, ExtensionError>;
	readonly cancel: (
		id: string,
		requestId: string,
	) => Effect.Effect<void, ExtensionError>;
	readonly invoke: (
		id: string,
		method: string,
		input: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
		requestId?: string,
	) => Effect.Effect<unknown, ExtensionError>;
	readonly logs: (
		id: string,
	) => Effect.Effect<ReadonlyArray<ExtensionLogEntry>, ExtensionError>;
	readonly marketplace: (
		refresh: boolean,
	) => Effect.Effect<ReadonlyArray<MarketplaceExtension>, ExtensionError>;
	readonly providers: () => Effect.Effect<
		ReadonlyArray<ExtensionProviderDescriptor>
	>;
	readonly invokeProvider: (
		providerId: string,
		operation: string,
		input: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
	) => Effect.Effect<unknown, ExtensionError>;
	readonly providerEvents: (sessionId: string) => Stream.Stream<unknown>;
}

export class ExtensionService extends Context.Service<
	ExtensionService,
	ExtensionServiceShape
>()("zuse/ExtensionService") {}
