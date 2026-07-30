export type ServeCli = (
	argv: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => Promise<void>;

export declare const runServeCli: ServeCli;
