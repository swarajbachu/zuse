import { PRODUCTION_API_URL, STAGING_API_URL } from "@zuse/contracts";

export const resolveRendererApiUrl = (
	configuredUrl: string | undefined,
	development: boolean,
): string =>
	(
		configuredUrl?.trim() ||
		(development ? STAGING_API_URL : PRODUCTION_API_URL)
	).replace(/\/$/u, "");

export const rendererApiUrl = (): string =>
	resolveRendererApiUrl(import.meta.env.VITE_ZUSE_API_URL, import.meta.env.DEV);
