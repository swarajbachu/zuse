/**
 * The version of the Zuse host serving this process. `zuse serve` sets the
 * installed runtime version; the desktop-embedded host reports the app version
 * it ships in.
 */
export const hostRuntimeVersion = (
	env: NodeJS.ProcessEnv = process.env,
): string =>
	env.ZUSE_RUNTIME_VERSION?.trim() || env.ZUSE_APP_VERSION?.trim() || "0.0.0";
