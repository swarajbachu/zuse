// Temporary preview channel: production signing and hosting remain separate.
import { STAGING_MARKETPLACE_BASE_URL } from "@zuse/extension-host";

export const EXTENSION_MARKETPLACE_CATALOG_URL = `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.json`;
export const EXTENSION_MARKETPLACE_SIGNATURE_URL = `${STAGING_MARKETPLACE_BASE_URL}/catalog.v1.sig`;
export { STAGING_MARKETPLACE_PUBLIC_KEY as EXTENSION_MARKETPLACE_PUBLIC_KEY } from "@zuse/extension-host";
