export { MARKETPLACE_PUBLIC_KEY } from "./catalog-key.ts";
export { compileExtension } from "./compiler.ts";
export { ExtensionHost } from "./host.ts";
export {
	assertApiCompatible,
	MANIFEST_FILENAME,
	RESERVED_PROVIDER_IDS,
	readExtensionManifest,
} from "./manifest.ts";
export {
	fetchMarketplaceCatalog,
	sha256,
	verifyMarketplaceCatalog,
} from "./marketplace.ts";

export { ProviderEventHub } from "./provider-events.ts";
export type * from "./types.ts";
