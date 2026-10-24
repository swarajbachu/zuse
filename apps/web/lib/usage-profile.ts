import {
	ApiPaths,
	PRODUCTION_API_URL,
	PublicUsageProfile,
} from "@zuse/contracts";
import { Schema } from "effect";
import { cache } from "react";

/** No shared cache: unpublish must apply to the next page request. */
export const getPublicUsageProfile = cache(async (handle: string) => {
	if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u.test(handle)) return null;
	const origin = (process.env.ZUSE_API_URL || PRODUCTION_API_URL).replace(
		/\/$/u,
		"",
	);
	const response = await fetch(
		`${origin}${ApiPaths.publicUsageProfile(handle)}`,
		{ cache: "no-store", signal: AbortSignal.timeout(10_000) },
	);
	if (response.status === 404) return null;
	if (!response.ok)
		throw new Error("Public usage profile is temporarily unavailable");
	return Schema.decodeUnknownSync(PublicUsageProfile)(await response.json());
});
