import { PRODUCTION_API_URL } from "@zuse/contracts";

/** Account requests do not require publishing this runtime as a computer. */
export const resolveAccountApiUrl = (
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => (env.ZUSE_API_URL ?? PRODUCTION_API_URL).replace(/\/+$/u, "");
