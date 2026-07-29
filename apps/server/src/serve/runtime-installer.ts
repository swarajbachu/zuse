import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageSpecifier = (version: string): string =>
	`@zusehq/serve@${version}`;

export const durableRuntimeExecutable = (
	dataDir: string,
	version: string,
): string =>
	join(
		dataDir,
		"runtime",
		version,
		"node_modules",
		"@zusehq",
		"serve",
		"dist",
		"bin.mjs",
	);

export const installDurableServeRuntime = async (input: {
	readonly dataDir: string;
	readonly version: string;
	readonly npmExecutable?: string;
}): Promise<string> => {
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.version)) {
		throw new Error(`Invalid Zuse Serve runtime version: ${input.version}`);
	}
	const executable = durableRuntimeExecutable(input.dataDir, input.version);
	try {
		await access(executable);
		return executable;
	} catch {
		// Install below.
	}
	const prefix = join(input.dataDir, "runtime", input.version);
	await mkdir(prefix, { recursive: true, mode: 0o700 });
	await execFileAsync(input.npmExecutable ?? "npm", [
		"install",
		"--prefix",
		prefix,
		"--no-audit",
		"--no-fund",
		"--save-exact",
		packageSpecifier(input.version),
	]);
	await access(executable);
	return executable;
};

export const latestServeRuntimeVersion = async (
	fetcher: typeof fetch = fetch,
): Promise<string> => {
	const response = await fetcher(
		"https://registry.npmjs.org/@zusehq%2Fserve/latest",
		{ signal: AbortSignal.timeout(15_000) },
	);
	const body = (await response.json().catch(() => ({}))) as {
		readonly version?: unknown;
	};
	if (!response.ok || typeof body.version !== "string") {
		throw new Error(`Unable to resolve the latest Serve runtime.`);
	}
	return body.version;
};

export interface ActiveServeRuntime {
	readonly version: string;
	readonly executable: string;
}

const activeRuntimePath = (dataDir: string): string =>
	join(dataDir, "runtime", "active.json");

export const readActiveServeRuntime = async (
	dataDir: string,
): Promise<ActiveServeRuntime | null> => {
	try {
		const value = JSON.parse(
			await readFile(activeRuntimePath(dataDir), "utf8"),
		) as Partial<ActiveServeRuntime>;
		return typeof value.version === "string" &&
			typeof value.executable === "string"
			? (value as ActiveServeRuntime)
			: null;
	} catch {
		return null;
	}
};

export const writeActiveServeRuntime = async (
	dataDir: string,
	runtime: ActiveServeRuntime,
): Promise<void> => {
	const directory = join(dataDir, "runtime");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const target = activeRuntimePath(dataDir);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(runtime), { mode: 0o600 });
	try {
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
};
