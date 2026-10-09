import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { Unzip, UnzipInflate } from "fflate";
import * as tar from "tar";
import snapshot from "./catalog-snapshot.json";

const Binary = Schema.Struct({
	archive: Schema.String,
	sha256: Schema.optional(Schema.String),
	cmd: Schema.String,
	args: Schema.optional(Schema.Array(Schema.String)),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Package = Schema.Struct({
	package: Schema.String,
	args: Schema.optional(Schema.Array(Schema.String)),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Local = Schema.Struct({
	command: Schema.String,
	args: Schema.optional(Schema.Array(Schema.String)),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	mcpEnabled: Schema.optional(Schema.Boolean),
});
export const Registry = Schema.Struct({
	version: Schema.String,
	agents: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			description: Schema.String,
			version: Schema.String,
			repository: Schema.optional(Schema.String),
			icon: Schema.optional(Schema.String),
			distribution: Schema.Struct({
				binary: Schema.optional(Schema.Record(Schema.String, Binary)),
				npx: Schema.optional(Package),
				uvx: Schema.optional(Package),
				local: Schema.optional(Local),
			}),
		}),
	),
});
export type Registry = typeof Registry.Type;
export type RegistryAgent = Registry["agents"][number];
const decode = Schema.decodeUnknownSync(Registry);
export const platformTarget = (
	platform = process.platform,
	arch = process.arch,
) =>
	`${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch}`;
export const distributionFor = (
	agent: RegistryAgent,
	target = platformTarget(),
) => {
	const binary = agent.distribution.binary?.[target];
	const windows = target.startsWith("windows-");
	// Node refuses to spawn batch files without a shell, and agents never get one.
	if (binary && !(windows && /\.(cmd|bat)$/i.test(binary.cmd)))
		return {
			kind: "binary" as const,
			// Windows registry entries may use `\` in `cmd`; archive entries may not.
			value: windows
				? { ...binary, cmd: binary.cmd.replaceAll("\\", "/") }
				: binary,
		};
	if (agent.distribution.npx)
		return { kind: "npx" as const, value: agent.distribution.npx };
	if (agent.distribution.uvx)
		return { kind: "uvx" as const, value: agent.distribution.uvx };
	const local = agent.distribution.local;
	if (local && !(windows && /\.(cmd|bat)$/i.test(local.command)))
		return { kind: "local" as const, value: local };
	return null;
};
export const readCatalog = async (
	directory: string,
	fetcher: typeof fetch = fetch,
): Promise<Registry> => {
	const file = join(directory, "catalog.json");
	let cached: Registry | undefined;
	try {
		cached = decode(JSON.parse(await readFile(file, "utf8")));
	} catch {
		/* Bundled fallback below. */
	}
	try {
		const response = await fetcher(
			"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
			{ signal: AbortSignal.timeout(10_000) },
		);
		if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
		const registry = decode(await response.json());
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temp = `${file}.${crypto.randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(registry), { mode: 0o600 });
		await rename(temp, file);
		return registry;
	} catch {
		return cached ?? decode(snapshot);
	}
};
export const safeArchivePath = (root: string, entry: string) => {
	if (entry.includes("\\") || entry.includes("\0") || /^[a-z]:/i.test(entry))
		throw new Error("Unsafe archive path");
	const path = resolve(root, entry);
	if (path !== resolve(root) && !path.startsWith(resolve(root) + sep))
		throw new Error("Archive path escapes installation directory");
	return path;
};
const run = promisify(execFile);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;

/** Streams the archive to disk so large agents never sit in server memory. */
const downloadArchive = async (
	url: URL,
	file: string,
	fetcher: typeof fetch,
	sha256: string | undefined,
) => {
	const response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
	if (!response.body) throw new Error("Empty agent archive");
	const hash = createHash("sha256");
	const out = createWriteStream(file, { mode: 0o600 });
	const finished = once(out, "finish");
	// The stream can fail while a read is pending; settle it until awaited below.
	finished.catch(() => {});
	let downloaded = 0;
	try {
		const reader = response.body.getReader();
		while (true) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			downloaded += chunk.byteLength;
			if (downloaded > MAX_ARCHIVE_BYTES)
				throw new Error("Agent archive exceeds 512 MiB");
			hash.update(chunk);
			if (!out.write(chunk)) await once(out, "drain");
		}
	} finally {
		out.end();
		await finished;
	}
	if (sha256 && hash.digest("hex") !== sha256.toLowerCase())
		throw new Error("Agent archive checksum mismatch");
};

interface ZipEntry {
	readonly name: string;
	readonly size: number;
	/** Unix mode from the central directory, or 0 when the archive has none. */
	readonly mode: number;
}

/** Reads the central directory, which carries the sizes and Unix modes. */
const readZipEntries = async (file: string): Promise<ZipEntry[]> => {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const tailSize = Math.min(size, 22 + 65_535);
		const tail = Buffer.alloc(tailSize);
		await handle.read(tail, 0, tailSize, size - tailSize);
		const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
		if (end < 0) throw new Error("Invalid agent archive");
		const count = tail.readUInt16LE(end + 10);
		const directorySize = tail.readUInt32LE(end + 12);
		const directoryOffset = tail.readUInt32LE(end + 16);
		if (count === 0xffff || directoryOffset === 0xffffffff)
			throw new Error("ZIP64 agent archives are not supported");
		const directory = Buffer.alloc(directorySize);
		await handle.read(directory, 0, directorySize, directoryOffset);
		const entries: ZipEntry[] = [];
		let offset = 0;
		for (let index = 0; index < count; index++) {
			if (directory.readUInt32LE(offset) !== 0x02014b50)
				throw new Error("Invalid agent archive");
			const nameLength = directory.readUInt16LE(offset + 28);
			const nameStart = offset + 46;
			entries.push({
				name: directory.toString("utf8", nameStart, nameStart + nameLength),
				size: directory.readUInt32LE(offset + 24),
				// Host system 3 is Unix; its mode lives in the high external bits.
				mode:
					directory.readUInt8(offset + 5) === 3
						? directory.readUInt32LE(offset + 38) >>> 16
						: 0,
			});
			offset =
				nameStart +
				nameLength +
				directory.readUInt16LE(offset + 30) +
				directory.readUInt16LE(offset + 32);
		}
		return entries;
	} finally {
		await handle.close();
	}
};

/**
 * Validates every entry before extracting, then inflates straight to disk and
 * restores executable bits: agents often ship helper binaries beside `cmd`.
 */
const extractZip = async (file: string, directory: string) => {
	const entries = await readZipEntries(file);
	let expanded = 0;
	for (const entry of entries) {
		safeArchivePath(directory, entry.name);
		expanded += entry.size;
		if (expanded > MAX_EXPANDED_BYTES)
			throw new Error("Expanded archive exceeds 1 GiB");
		const type = entry.mode & 0o170000;
		if (type !== 0 && type !== 0o100000 && type !== 0o040000)
			throw new Error("Unsupported archive entry type");
		await mkdir(
			entry.name.endsWith("/")
				? safeArchivePath(directory, entry.name)
				: dirname(safeArchivePath(directory, entry.name)),
			{ recursive: true },
		);
	}
	const unzip = new Unzip();
	unzip.register(UnzipInflate);
	const writes: Promise<unknown>[] = [];
	let current: ReturnType<typeof createWriteStream> | undefined;
	const outputs: ReturnType<typeof createWriteStream>[] = [];
	let failure: Error | undefined;
	let written = 0;
	unzip.onfile = (entry) => {
		if (entry.name.endsWith("/")) return;
		const out = createWriteStream(safeArchivePath(directory, entry.name), {
			mode: 0o600,
		});
		current = out;
		outputs.push(out);
		writes.push(
			finished(out).catch((error: Error) => {
				failure ??= error;
			}),
		);
		entry.ondata = (error, chunk, final) => {
			// fflate reports errors (e.g. unsupported compression) without a chunk.
			if (error) failure ??= error;
			if (chunk) written += chunk.byteLength;
			if (written > MAX_EXPANDED_BYTES)
				failure ??= new Error("Expanded archive exceeds 1 GiB");
			if (failure) {
				out.destroy();
				return;
			}
			if (chunk) out.write(chunk);
			if (final) out.end();
		};
		entry.start();
	};
	try {
		for await (const chunk of createReadStream(file)) {
			unzip.push(chunk as Uint8Array);
			if (failure) throw failure;
			if (current?.writableNeedDrain) await once(current, "drain");
		}
		unzip.push(new Uint8Array(0), true);
		if (failure) throw failure;
		await Promise.all(writes);
		if (failure) throw failure;
	} catch (error) {
		// Never leave a stream open: install runs inside the store's write lock.
		for (const output of outputs) output.destroy();
		throw error;
	}
	for (const entry of entries) {
		if (entry.name.endsWith("/")) continue;
		await chmod(
			safeArchivePath(directory, entry.name),
			entry.mode & 0o111 ? 0o700 : 0o600,
		);
	}
};
export const installCatalogAgent = async (
	agent: RegistryAgent,
	directory: string,
	fetcher: typeof fetch = fetch,
	resolveExecutable: (name: string) => Promise<string> = async (name) => name,
	/** Shared across installs so updates and re-adds reuse downloaded packages. */
	cacheDirectory = directory,
) => {
	const distribution = distributionFor(agent);
	if (!distribution)
		throw new Error("This agent has no distribution for this host.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const env = distribution.value.env ?? {};
	if (distribution.kind === "local") {
		return {
			command: await resolveExecutable(distribution.value.command),
			args: [...(distribution.value.args ?? [])],
			env,
			mcpEnabled: distribution.value.mcpEnabled,
		};
	}
	if (distribution.kind !== "binary") {
		const runnerName = distribution.kind === "npx" ? "npx" : "uvx";
		const runner = await resolveExecutable(runnerName);
		try {
			await run(runner, ["--version"], { timeout: 15_000 });
		} catch {
			throw new Error(
				`Install ${runnerName === "npx" ? "Node.js and npm" : "uv"} on this host first.`,
			);
		}
		const spec =
			distribution.kind === "uvx"
				? distribution.value.package.replace(/@(?=[^@]+$)/, "==")
				: distribution.value.package;
		// Registry packages are normally pinned; pin unversioned entries to the manifest version.
		const pinned =
			distribution.kind === "npx"
				? /@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec)
					? spec
					: `${spec.replace(/@[^/]+$/, "")}@${agent.version}`
				: spec.includes("==")
					? spec
					: `${spec}==${agent.version}`;
		const cacheEnv: Record<string, string> =
			distribution.kind === "npx"
				? { npm_config_cache: join(cacheDirectory, "npm-cache") }
				: { UV_CACHE_DIR: join(cacheDirectory, "uv-cache") };
		const args =
			distribution.kind === "npx"
				? ["--yes", pinned, ...(distribution.value.args ?? [])]
				: [
						"--from",
						pinned,
						spec.split(/[=<>]/)[0] ?? spec,
						...(distribution.value.args ?? []),
					];
		return { command: runner, args, env: { ...env, ...cacheEnv } };
	}
	const source = distribution.value;
	const url = new URL(source.archive);
	if (url.protocol !== "https:")
		throw new Error("Agent downloads must use HTTPS");
	const archive = join(directory, "download");
	try {
		await downloadArchive(url, archive, fetcher, source.sha256);
		if (/\.zip$/i.test(url.pathname)) {
			await extractZip(archive, directory);
		} else if (/\.(tar\.gz|tgz|tar|tar\.bz2|tbz2)$/i.test(url.pathname)) {
			if (/\.(tar\.bz2|tbz2)$/i.test(url.pathname)) {
				const result = await run("bzip2", ["-dc", archive], {
					encoding: "buffer",
					maxBuffer: 1024 * 1024 * 1024,
					timeout: 60_000,
				});
				await writeFile(archive, result.stdout);
			}
			// Validate the complete archive before extracting any entry. Links are not allowed.
			let invalid: Error | undefined;
			let expanded = 0;
			await tar.t({
				file: archive,
				onReadEntry: (entry) => {
					try {
						safeArchivePath(directory, entry.path);
					} catch {
						invalid = new Error("Unsafe archive path");
					}
					expanded += entry.size;
					if (expanded > 1024 * 1024 * 1024)
						invalid = new Error("Expanded archive exceeds 1 GiB");
					if (
						![
							"File",
							"Directory",
							"OldFile",
							"ExtendedHeader",
							"GlobalExtendedHeader",
						].includes(entry.type)
					)
						invalid = new Error("Unsupported archive entry type");
				},
			});
			if (invalid) throw invalid;
			await tar.x({
				file: archive,
				cwd: directory,
				strict: true,
				preservePaths: false,
			});
		} else {
			await mkdir(dirname(safeArchivePath(directory, source.cmd)), {
				recursive: true,
			});
			await rename(archive, safeArchivePath(directory, source.cmd));
		}
	} finally {
		await rm(archive, { force: true });
	}
	const command = safeArchivePath(directory, source.cmd);
	await chmod(command, 0o700);
	return { command, args: [...(source.args ?? [])], env };
};
