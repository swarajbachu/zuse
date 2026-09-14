/** Temporary preview trust root; never accepted by the production catalog. */
export const STAGING_MARKETPLACE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQygfeUue38sZOYgPMounTghlmQtvlxGYTRGIyQOhNeM=
-----END PUBLIC KEY-----`;

/** Keep the API 1.0 feed intact for older desktop manifest decoders. */
export const STAGING_MARKETPLACE_DIRECTORY = "extensions/staging/api-1.1";

export const STAGING_MARKETPLACE_BASE_URL =
	"https://raw.githubusercontent.com/swarajbachu/zuse/refs/heads/swarajbachu/hat-yai-v1/apps/web/public/extensions/staging/api-1.1";
