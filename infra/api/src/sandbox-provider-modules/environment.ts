import { Schema } from "effect";
import { SandboxProviderConfigurationError } from "../sandbox-provider-module.ts";

/** A configured value: trimmed, non-empty, and not a `REPLACE_WITH` placeholder. */
export const ConfiguredString = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.makeFilter(
		(value) =>
			!value.startsWith("REPLACE_WITH") ||
			"Placeholder values are not configured",
	),
);

/** An HTTPS URL; adapters normalize the trailing slash of `.href` themselves. */
export const HttpsUrl = Schema.URLFromString.check(
	Schema.makeFilter((url) => url.protocol === "https:" || "URL must use HTTPS"),
);

/**
 * Decodes a provider's environment, reporting any schema failure as that
 * provider's configuration error so the boot log names the adapter at fault.
 */
export const decodeProviderEnvironment = <
	S extends Schema.ConstraintDecoder<unknown>,
>(
	schema: S,
	env: unknown,
	provider: string,
): S["Type"] => {
	try {
		return Schema.decodeUnknownSync(schema)(env);
	} catch {
		throw new SandboxProviderConfigurationError({
			message: `Invalid ${provider} sandbox provider configuration`,
		});
	}
};
