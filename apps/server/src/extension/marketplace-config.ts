// Temporary hosting for Extensions Preview until the signed catalog is deployed
// to zuse.sh. GitHub serves the committed files directly; signature and artifact
// digest verification remain mandatory even though this staging branch can move.
const marketplaceBaseUrl =
	"https://raw.githubusercontent.com/swarajbachu/zuse/refs/heads/swarajbachu/hat-yai-v1/apps/web/public/extensions";

export const EXTENSION_MARKETPLACE_CATALOG_URL = `${marketplaceBaseUrl}/catalog.v1.json`;
export const EXTENSION_MARKETPLACE_SIGNATURE_URL = `${marketplaceBaseUrl}/catalog.v1.sig`;

export { MARKETPLACE_PUBLIC_KEY as EXTENSION_MARKETPLACE_PUBLIC_KEY } from "@zuse/extension-host";
