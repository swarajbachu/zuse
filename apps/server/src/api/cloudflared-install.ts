import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION = "2026.7.2";
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;

export interface CloudflaredAsset {
	readonly version: typeof VERSION;
	readonly name: string;
	readonly sha256: string;
	readonly archive: boolean;
}

const ASSETS = {
	"darwin:x64": {
		name: "cloudflared-darwin-amd64.tgz",
		sha256: "a5afb0ba3da859da47bebc9a918d5b196bf7e4aec23589419b46356731bcc75f",
		archive: true,
	},
	"darwin:arm64": {
		name: "cloudflared-darwin-arm64.tgz",
		sha256: "0588df58494a6cadd38b9deb6078908a5054063c80784d92fdb8d4a5f3de1c67",
		archive: true,
	},
	"linux:x64": {
		name: "cloudflared-linux-amd64",
		sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
		archive: false,
	},
	"linux:arm64": {
		name: "cloudflared-linux-arm64",
		sha256: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
		archive: false,
	},
} as const;

export const cloudflaredAsset = (
	platform: NodeJS.Platform,
	architecture: string,
): CloudflaredAsset => {
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error(`Unsupported platform for managed tunnel: ${platform}`);
	}
	if (architecture !== "x64" && architecture !== "arm64") {
		throw new Error(
			`Unsupported architecture for managed tunnel: ${architecture}`,
		);
	}
	return { version: VERSION, ...ASSETS[`${platform}:${architecture}`] };
};

export const verifySha256 = (contents: Buffer, expected: string): void => {
	const actual = createHash("sha256").update(contents).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`Managed tunnel binary checksum mismatch (expected ${expected}, got ${actual}).`,
		);
	}
};

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

export const ensurePinnedCloudflared = async (input: {
	readonly userData: string;
	readonly fetcher?: typeof fetch;
	readonly platform?: NodeJS.Platform;
	readonly architecture?: string;
}): Promise<string> => {
	const asset = cloudflaredAsset(
		input.platform ?? process.platform,
		input.architecture ?? process.arch,
	);
	const installDir = join(
		input.userData,
		"runtime",
		"cloudflared",
		asset.version,
	);
	const target = join(installDir, "cloudflared");
	const installedChecksum = join(installDir, "cloudflared.sha256");
	if (await exists(target)) {
		const installed = await readFile(target);
		const actual = createHash("sha256").update(installed).digest("hex");
		const expected = asset.archive
			? await readFile(installedChecksum, "utf8").catch(() => "")
			: asset.sha256;
		if (actual === expected.trim()) {
			await chmod(target, 0o700);
			return target;
		}
		await rm(target, { force: true });
		await rm(installedChecksum, { force: true });
	}

	await mkdir(installDir, { recursive: true, mode: 0o700 });
	const fetcher = input.fetcher ?? fetch;
	const response = await fetcher(`${RELEASE_BASE}/${asset.name}`, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) {
		throw new Error(
			`Managed tunnel download failed (${response.status} ${response.statusText}).`,
		);
	}
	const contents = Buffer.from(await response.arrayBuffer());
	verifySha256(contents, asset.sha256);

	const download = join(installDir, `${asset.name}.download`);
	await writeFile(download, contents, { mode: 0o600 });
	try {
		if (asset.archive) {
			const staging = join(installDir, `extract-${process.pid}-${Date.now()}`);
			await mkdir(staging, { mode: 0o700 });
			try {
				await execFileAsync("tar", ["-xzf", download, "-C", staging]);
				const extracted = join(staging, "cloudflared");
				await chmod(extracted, 0o700);
				await rename(extracted, target);
				const installed = await readFile(target);
				await writeFile(
					installedChecksum,
					createHash("sha256").update(installed).digest("hex"),
					{ mode: 0o600 },
				);
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
		} else {
			await chmod(download, 0o700);
			await rename(download, target);
		}
	} finally {
		await rm(download, { force: true });
	}
	return target;
};
