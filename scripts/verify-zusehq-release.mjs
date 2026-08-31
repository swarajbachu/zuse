import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packages = [
	{ directory: "apps/server", name: "@zusehq/server" },
	{ directory: "packages/serve", name: "@zusehq/serve" },
	{ directory: "packages/zusehq", name: "zusehq" },
];

const run = (command, args, options = {}) =>
	new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? root,
			env: options.env ?? process.env,
			stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) return resolveRun({ stdout, stderr });
			reject(
				new Error(
					`${command} ${args.join(" ")} failed (${code ?? signal})\n${stdout}${stderr}`,
				),
			);
		});
	});

const manifest = async (directory) =>
	JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));

const freePort = () =>
	new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("Could not allocate a TCP port.")));
				return;
			}
			server.close(() => resolvePort(address.port));
		});
	});

const waitFor = async (description, check, timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Timed out waiting for ${description}.`);
};

const stop = async (child) => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolveExit) => child.once("exit", resolveExit)),
		new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
	]);
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGKILL");
};

const tempRoot = await mkdtemp(join(tmpdir(), "zusehq-release-smoke-"));
try {
	const manifests = Object.fromEntries(
		await Promise.all(
			packages.map(async ({ directory, name }) => [
				name,
				await manifest(directory),
			]),
		),
	);
	if (
		manifests["@zusehq/serve"].dependencies["@zusehq/server"] !==
		manifests["@zusehq/server"].version
	) {
		throw new Error(
			"@zusehq/serve must pin the package being built for @zusehq/server.",
		);
	}
	if (
		manifests.zusehq.dependencies["@zusehq/serve"] !==
		manifests["@zusehq/serve"].version
	) {
		throw new Error(
			"zusehq must pin the package being built for @zusehq/serve.",
		);
	}

	await run("bun", ["run", "--filter", "@zusehq/server", "build:bundle"]);
	await run("bun", ["run", "--filter", "@zusehq/serve", "build"]);
	await run("bun", ["run", "--filter", "zusehq", "build"]);

	const tarballs = [];
	for (const { directory } of packages) {
		const packed = await run(
			"npm",
			["pack", "--json", "--pack-destination", tempRoot],
			{ cwd: join(root, directory), capture: true },
		);
		const result = JSON.parse(packed.stdout);
		const filename = result[0]?.filename;
		if (typeof filename !== "string")
			throw new Error(`npm pack failed for ${directory}.`);
		tarballs.push(join(tempRoot, basename(filename)));
	}

	const installDir = join(tempRoot, "install");
	const dataDir = join(tempRoot, "data");
	await mkdir(installDir, { recursive: true });
	await writeFile(
		join(installDir, "package.json"),
		JSON.stringify({ name: "zusehq-release-smoke", private: true }),
	);
	await run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
		cwd: installDir,
	});

	const port = await freePort();
	const minimumNode = (
		await run("npx", ["--yes", "node@22.13.0", "-p", "process.execPath"], {
			capture: true,
		})
	).stdout.trim();
	const executable = join(
		installDir,
		"node_modules",
		"zusehq",
		"dist",
		"bin.mjs",
	);
	const env = {
		...process.env,
		ZUSE_ENABLE_PAIRING: "0",
		ZUSE_SERVER_READY_STDOUT: "1",
		ZUSE_USER_DATA_DIR: dataDir,
	};
	const server = spawn(
		minimumNode,
		[
			executable,
			"serve",
			"--foreground",
			"--no-account",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--data-dir",
			dataDir,
		],
		{ cwd: installDir, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let serverOutput = "";
	server.stdout.on("data", (chunk) => {
		serverOutput += chunk;
	});
	server.stderr.on("data", (chunk) => {
		serverOutput += chunk;
	});
	try {
		await waitFor("packed Serve readiness", () =>
			serverOutput.includes("ZUSE_SERVER_READY "),
		);
		const accessFile = join(dataDir, "cli-access.json");
		await waitFor("packed CLI access descriptor", async () => {
			try {
				await stat(accessFile);
				return true;
			} catch {
				return false;
			}
		});
		const access = JSON.parse(await readFile(accessFile, "utf8"));
		if (access.wsUrl !== `ws://127.0.0.1:${port}/rpc`) {
			throw new Error(
				`Packed Serve wrote an unexpected RPC URL: ${access.wsUrl}`,
			);
		}
		if (((await stat(accessFile)).mode & 0o777) !== 0o600) {
			throw new Error("Packed Serve CLI access descriptor is not mode 0600.");
		}
		const listed = await run(minimumNode, [executable, "computer", "list"], {
			cwd: installDir,
			env,
			capture: true,
		});
		const envelope = JSON.parse(listed.stdout.trim());
		if (envelope.ok !== true || listed.stderr.includes("SocketOpenError")) {
			throw new Error(
				`Packed zusehq could not connect to packed Serve: ${listed.stdout}${listed.stderr}`,
			);
		}
	} catch (error) {
		throw new Error(`${error.message}\nServe output:\n${serverOutput}`, {
			cause: error,
		});
	} finally {
		await stop(server);
	}
	console.log(
		`Packed zusehq ${manifests.zusehq.version} connected to @zusehq/serve ${manifests["@zusehq/serve"].version} and @zusehq/server ${manifests["@zusehq/server"].version}.`,
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
