/** Merge a child environment, then remove overrides that must not reach it. */
export const childProcessEnv = (
	base: NodeJS.ProcessEnv,
	overrides: NodeJS.ProcessEnv = {},
	unset: readonly string[] = [],
): NodeJS.ProcessEnv => {
	const env = { ...base, ...overrides };
	for (const key of unset) delete env[key];
	return env;
};
