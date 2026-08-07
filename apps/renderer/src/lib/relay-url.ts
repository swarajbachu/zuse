import { PRODUCTION_RELAY_URL, STAGING_RELAY_URL } from "@zuse/contracts";

const environment = (): Record<string, string | undefined> =>
	(import.meta as { readonly env?: Record<string, string | undefined> }).env ??
	{};

export const resolveRendererRelayUrl = (
	configuredUrl: string | undefined,
	development: boolean,
): string =>
	(
		configuredUrl?.trim() ||
		(development ? STAGING_RELAY_URL : PRODUCTION_RELAY_URL)
	).replace(/\/$/u, "");

export const rendererRelayUrl = (): string =>
	resolveRendererRelayUrl(
		environment().VITE_ZUSE_RELAY_URL,
		import.meta.env.DEV,
	);
