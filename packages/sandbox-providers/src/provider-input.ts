import { Effect } from "effect";
import { SandboxProviderError } from "./index.ts";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Environment variable names a provider can hand to a shell without quoting risk. */
export const validatedEnv = (
	env: Readonly<Record<string, string>>,
): Effect.Effect<Readonly<Record<string, string>>, SandboxProviderError> =>
	Object.keys(env).every((key) => ENV_KEY_PATTERN.test(key))
		? Effect.succeed(env)
		: Effect.fail(new SandboxProviderError({ code: "rejected" }));

/** Whole seconds within a provider's accepted timer range. */
export const clampSeconds = (
	seconds: number,
	minimum: number,
	maximum: number,
): number => Math.min(maximum, Math.max(minimum, Math.trunc(seconds)));
