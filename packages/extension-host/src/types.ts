import type {
	ExtensionCapability,
	ExtensionCatalog,
	ExtensionListItem,
	ExtensionLogEntry,
	ExtensionManifest,
	ExtensionSource,
	MarketplaceExtension,
} from "@zuse/contracts";

export interface CompiledExtension {
	readonly clientBundle: string;
	readonly clientCss: string;
	readonly serverBundle: string;
}

export type ExtensionHostCommand =
	| { readonly _tag: "set-global-enabled"; readonly enabled: boolean }
	| {
			readonly _tag: "install";
			readonly source: ExtensionSource;
			readonly grantedCapabilities: ReadonlyArray<ExtensionCapability>;
	  }
	| { readonly _tag: "enable"; readonly id: string }
	| { readonly _tag: "disable"; readonly id: string }
	| { readonly _tag: "reload"; readonly id: string }
	| {
			readonly _tag: "update";
			readonly id: string;
			readonly grantedCapabilities: ReadonlyArray<ExtensionCapability>;
	  }
	| {
			readonly _tag: "remove";
			readonly id: string;
			readonly deleteData: boolean;
	  };

export type ExtensionHostCommandResult =
	| { readonly _tag: "catalog"; readonly catalog: ExtensionCatalog }
	| { readonly _tag: "item"; readonly item: ExtensionListItem }
	| { readonly _tag: "void" };

export interface ExtensionHostInterface {
	start(): Promise<void>;
	snapshot(): ExtensionCatalog;
	subscribe(listener: (catalog: ExtensionCatalog) => void): () => void;
	inspect(source: ExtensionSource): Promise<ExtensionManifest>;
	execute(command: ExtensionHostCommand): Promise<ExtensionHostCommandResult>;
	invoke(
		id: string,
		method: string,
		input: unknown,
		workspace?: import("@zuse/extension-sdk").ExtensionWorkspaceContext,
	): Promise<unknown>;
	providerDescriptors(): ReadonlyArray<
		import("@zuse/contracts").ExtensionProviderDescriptor
	>;
	invokeProvider(
		providerId: string,
		operation: string,
		input: unknown,
	): Promise<unknown>;
	subscribeProviderEvents(
		listener: (sessionId: string, event: unknown) => void,
	): () => void;
	logs(id: string): ReadonlyArray<ExtensionLogEntry>;
	marketplace(refresh?: boolean): Promise<ReadonlyArray<MarketplaceExtension>>;
	stop(): Promise<void>;
}

export interface ExtensionSecretStore {
	get(extensionId: string, key: string): Promise<string | null>;
	set(extensionId: string, key: string, value: string): Promise<void>;
	delete(extensionId: string, key: string): Promise<void>;
}

export interface ExtensionHostDependencies {
	readonly rootDirectory: string;
	readonly secretStore: ExtensionSecretStore;
	readonly marketplace?: {
		readonly catalogUrl: string;
		readonly signatureUrl: string;
		readonly publicKeyPem: string;
	};
	readonly now?: () => Date;
	readonly fetch?: typeof globalThis.fetch;
}
