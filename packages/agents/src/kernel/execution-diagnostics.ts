/** Raw provider diagnostics may contain partial or encoded credentials. Disable payload
 * diagnostics for managed-environment sessions before any truncation/serialization.
 * Structured provider events are masked by the server before persistence instead. */
export const hasManagedEnvironment = (
	environment: Readonly<Record<string, string>> | undefined,
): boolean => environment !== undefined && Object.keys(environment).length > 0;

export const executionDiagnostics = (disabled: boolean) => ({
	write: (text: string): void => {
		if (!disabled) process.stderr.write(text);
	},
	warn: (...args: unknown[]): void => {
		if (!disabled) console.warn(...args);
	},
	log: (...args: unknown[]): void => {
		if (!disabled) console.log(...args);
	},
});
