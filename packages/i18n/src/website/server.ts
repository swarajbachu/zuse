import { type WebsiteCatalog, websiteLoaders } from "../generated/website.ts";
import type { WebsiteLocale } from "../registry.ts";
/** Request-local resources. Only this dictionary crosses the server/client boundary. */
export async function loadWebsiteCatalog(
	locale: WebsiteLocale,
): Promise<WebsiteCatalog> {
	const [english, selected] = await Promise.all([
		websiteLoaders.en(),
		websiteLoaders[locale](),
	]);
	return { ...english, ...selected };
}
