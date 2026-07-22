import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { type FakeAcpScenario, installFakeAcpProvider } from "./fake-acp.ts";
import { keytarShimRequirePath } from "./fake-provider-peers.ts";
import {
	type ManagedChildProcess,
	makeHermeticEnvironment,
	makeTemporaryDirectory,
	spawnManaged,
} from "./process.ts";

export type HeadlessServerHarness = {
	readonly endpoint: string;
	readonly port: number;
	readonly root: string;
	readonly userData: string;
	readonly process: ManagedChildProcess;
	readonly stop: (signal?: NodeJS.Signals) => Promise<void>;
};

const repoRoot = resolve(
	fileURLToPath(new NodeUrl("../../../", import.meta.url)),
);

export const startHeadlessServer = async (options?: {
	readonly root?: string;
	readonly scenario?: FakeAcpScenario;
	readonly controlPort?: number;
	readonly host?: string;
	readonly authPolicy?: "auto" | "local" | "protected";
}): Promise<HeadlessServerHarness> => {
	const temporary =
		options?.root === undefined ? makeTemporaryDirectory("zuse-system-") : null;
	const root = options?.root ?? temporary?.path;
	if (root === undefined) throw new Error("System test root was not created.");
	const home = join(root, "home");
	const userData = join(root, "user-data");
	mkdirSync(home, { recursive: true });
	mkdirSync(userData, { recursive: true });
	const provider = installFakeAcpProvider({
		root,
		scenario: options?.scenario,
		controlPort: options?.controlPort,
	});
	const childProcess = spawnManaged(
		join(repoRoot, "node_modules", ".bin", "tsx"),
		[join(repoRoot, "apps/server/src/bin.ts")],
		{
			cwd: repoRoot,
			env: makeHermeticEnvironment({
				...provider.environment,
				HOME: home,
				XDG_DATA_HOME: join(home, ".local", "share"),
				ZUSE_HOST: options?.host ?? "127.0.0.1",
				ZUSE_AUTH_POLICY: options?.authPolicy ?? "auto",
				NODE_OPTIONS: `--require=${keytarShimRequirePath}`,
				ZUSE_PORT: "0",
				ZUSE_SERVER_READY_STDOUT: "1",
				ZUSE_USER_DATA: userData,
				PATH: provider.binDirectory,
			}),
		},
	);
	try {
		const line = await childProcess.waitForStdout(
			(candidate) => candidate.startsWith("ZUSE_SERVER_READY "),
			"headless server readiness",
			20_000,
		);
		const ready = JSON.parse(line.slice("ZUSE_SERVER_READY ".length)) as {
			readonly host: string;
			readonly port: number;
		};
		if (!(ready.port > 0)) throw new Error(`Invalid server port: ${line}`);
		return {
			endpoint: `ws://${ready.host === "0.0.0.0" ? "127.0.0.1" : ready.host}:${ready.port}`,
			port: ready.port,
			root,
			userData,
			process: childProcess,
			stop: async (signal) => {
				await childProcess.stop(signal);
				if (temporary !== null) temporary.dispose();
			},
		};
	} catch (cause) {
		await childProcess.stop();
		if (temporary !== null) temporary.dispose();
		throw cause;
	}
};

export const hasProductionDatabase = (
	harness: HeadlessServerHarness,
): boolean => existsSync(join(harness.userData, "zuse.sqlite"));
