import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usage =
	"Usage: npx zusehq snapshot <install|update> [--user development-user] [--channel production|staging]";
const installerFiles = [
	"install-snapshot.sh",
	"runtime-updater.mjs",
	"snapshot-release.json",
	"sshd_config",
	"SHA256SUMS",
];
const maxDownloadBytes = 8 * 1024 * 1024;

const run = (command: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} failed (${signal ?? code}).`));
		});
	});

export async function installSnapshot(
	args: string[],
	dependencies = { fetch, run, platform: process.platform, arch: process.arch },
): Promise<void> {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
		console.log(
			`${usage}\nInstall or update the Zuse runtime on a Debian/Ubuntu Boxd base snapshot machine.\nRepository paths and authentication are configured in the Zuse UI.`,
		);
		return;
	}
	let channel = "production";
	const installerArgs: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (option === undefined || value === undefined || seen.has(option))
			throw new Error(usage);
		seen.add(option);
		if (
			option === "--channel" &&
			(value === "production" || value === "staging")
		)
			channel = value;
		else if (
			option === "--user" &&
			/^[a-z_][a-z0-9_-]{0,31}$/u.test(value) &&
			value !== "root"
		)
			installerArgs.push(option, value);
		else throw new Error(usage);
	}
	const installerUrl = `https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-${channel}/zuse-snapshot-installer.tar.gz`;
	if (dependencies.platform !== "linux" || dependencies.arch !== "x64")
		throw new Error(
			"Run this command inside your Linux x86_64 Boxd machine, not on your desktop.",
		);
	const directory = await mkdtemp(join(tmpdir(), "zuse-snapshot-"));
	try {
		console.log("Downloading the Zuse snapshot installer…");
		const response = await dependencies.fetch(installerUrl, {
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok || !response.body)
			throw new Error(
				`Snapshot installer download failed (HTTP ${response.status}). Check your connection and that the ${channel} snapshot installer has been published, then retry.`,
			);
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxDownloadBytes)
					throw new Error(
						"Snapshot installer download exceeds the size limit.",
					);
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		const archive = join(directory, "installer.tar.gz");
		await writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
		await dependencies.run("tar", [
			"-xzf",
			archive,
			"--no-same-owner",
			"--no-same-permissions",
			"-C",
			directory,
			...installerFiles,
		]);
		for (const name of installerFiles) {
			if (!(await lstat(join(directory, name))).isFile())
				throw new Error(`Invalid installer bundle file: ${name}`);
		}
		const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
		for (const name of installerFiles.filter((file) => file !== "SHA256SUMS")) {
			const hash = createHash("sha256")
				.update(await readFile(join(directory, name)))
				.digest("hex");
			if (!checksums.split("\n").includes(`${hash}  ${name}`))
				throw new Error(`Installer checksum mismatch: ${name}`);
		}
		await dependencies.run("bash", [
			join(directory, "install-snapshot.sh"),
			...installerArgs,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
