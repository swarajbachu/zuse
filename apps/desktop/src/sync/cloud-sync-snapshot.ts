import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	appendFile,
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { cloudSshConfigPath } from "../ssh/cloud-ssh-service.ts";
import { ARCHIVE_SNAPSHOT_SCRIPT } from "./cloud-sync-archive.ts";

export const SYNC_MARKER_FILE = ".zuse-sync.json";
export interface SyncFile {
	path: string;
	hash: string;
	mode: number;
	size: number;
	link?: string;
	stamp?: string;
}
export interface SyncManifest {
	version: 1;
	workspaceId: string;
	files: SyncFile[];
	pending?: SyncFile[];
}
export const validSyncPath = (path: string): boolean =>
	path.length > 0 &&
	!path.includes("\\") &&
	!path.includes("\0") &&
	path
		.split("/")
		.every(
			(p) =>
				p !== "" &&
				p !== "." &&
				p !== ".." &&
				p !== ".git" &&
				p !== SYNC_MARKER_FILE,
		);

// Runs in the authenticated sandbox, with only Python's standard library and Git.
// Git selects files; no language/framework-specific exclusion list is involved.
export const SNAPSHOT_SCRIPT = String.raw`
import os, sys, json, stat, hashlib, subprocess, tempfile, time
root = os.path.realpath(sys.argv[1])
previous = {f['path']: f for f in json.load(sys.stdin)}
out = sys.stdout.buffer
last_progress = time.monotonic()

def emit(value):
 out.write(json.dumps(value, ensure_ascii=True).encode() + b'\n')

def progress():
 global last_progress
 if time.monotonic() - last_progress >= 10:
  emit(dict(progress=True)); out.flush()
  last_progress = time.monotonic()

checked_parents = set()
def paths(repo, prefix=''):
 result = subprocess.run(['git', '-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'], check=True, stdout=subprocess.PIPE)
 for raw in sorted(set(result.stdout.split(b'\0'))):
  if not raw: continue
  name = os.fsdecode(raw)
  rel = prefix + name
  rel.encode("utf-8")
  if any(p in ('', '.', '..', '.git', '.zuse-sync.json') for p in rel.split('/')) or '\\' in rel:
   raise RuntimeError('Unsupported repository path')
  absolute = os.path.join(root, rel)
  parent = os.path.dirname(absolute)
  while parent != root and parent not in checked_parents:
   if os.path.islink(parent): raise RuntimeError('Symlink ancestor: ' + rel)
   checked_parents.add(parent)
   parent = os.path.dirname(parent)
  try: info = os.lstat(absolute)
  except FileNotFoundError: continue
  if stat.S_ISDIR(info.st_mode):
   # Git lists initialized submodules as gitlinks, not their individual files.
   if os.path.exists(os.path.join(absolute, '.git')):
    yield from paths(absolute, rel + '/')
   else: raise RuntimeError('Uninitialized submodule or replaced tracked file: ' + rel)
  else: yield rel

selected = list(paths(root))
emit(dict(totalFiles=len(selected))); out.flush()
for rel in selected:
 progress()
 absolute = os.path.join(root, rel)
 for attempt in range(3):
  try:
   before = os.lstat(absolute)
   signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
   stamp = ':'.join(str(n) for n in signature(before))
   prior = previous.get(rel)
   if prior and prior.get('stamp') == stamp:
    emit(dict(prior, content=False))
    break
   if stat.S_ISLNK(before.st_mode):
    link = os.readlink(absolute)
    entry = dict(path=rel, hash=hashlib.sha256(link.encode()).hexdigest(), mode=511, size=0, link=link, stamp=stamp)
    if signature(before) != signature(os.lstat(absolute)): continue
    emit(dict(entry, content=False))
    break
   if not stat.S_ISREG(before.st_mode): raise RuntimeError('Unsupported file type: ' + rel)
   # Snapshot one file at a time, bounded memory, and verify it did not change
   # while being copied. Scratch data is outside the repository.
   with tempfile.TemporaryFile() as snapshot:
    digest = hashlib.sha256()
    with open(absolute, 'rb') as source:
     opened = os.fstat(source.fileno())
     while True:
      chunk = source.read(262144)
      if not chunk: break
      snapshot.write(chunk); digest.update(chunk)
      progress()
     after = os.fstat(source.fileno())
    current = os.lstat(absolute)
    if signature(before) != signature(opened) or signature(opened) != signature(after) or signature(after) != signature(current): continue
    entry = dict(path=rel, hash=digest.hexdigest(), mode=stat.S_IMODE(after.st_mode) & 511, size=after.st_size, stamp=stamp)
    prior = previous.get(rel)
    content = not prior or prior.get('hash') != entry['hash'] or prior.get('size') != entry['size'] or prior.get('mode') != entry['mode'] or 'link' in prior
    emit(dict(entry, content=content))
    if content:
     snapshot.seek(0)
     while True:
      chunk = snapshot.read(262144)
      if not chunk: break
      out.write(chunk)
    break
  except FileNotFoundError:
   break
 else: raise RuntimeError('File kept changing during snapshot: ' + rel)
emit(dict(done=True))
out.flush()
`;

const digestFile = async (path: string): Promise<string> => {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
};
const exists = async (path: string) =>
	lstat(path).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return null;
		throw cause;
	});
const assertParents = async (
	root: string,
	path: string,
	removing = new Set<string>(),
): Promise<void> => {
	let parent = dirname(path);
	while (parent !== ".") {
		const info = await exists(join(root, parent));
		if (
			!removing.has(parent) &&
			info !== null &&
			(!info.isDirectory() || info.isSymbolicLink())
		)
			throw new Error(
				`Sync destination has a non-directory ancestor: ${parent}`,
			);
		parent = dirname(parent);
	}
};
export const localBaseline = async (
	root: string,
	files: SyncFile[],
): Promise<SyncFile[]> => {
	const result: SyncFile[] = [];
	// Verify local bytes: manual edits and a process interrupted during publication
	// must not cause the next remote scan to incorrectly omit a needed file.
	for (const file of files) {
		try {
			await assertParents(root, file.path);
		} catch {
			continue;
		}
		const path = join(root, file.path);
		const info = await exists(path);
		if (info === null) continue;
		if (file.link !== undefined) {
			if (info.isSymbolicLink() && (await readlink(path)) === file.link)
				result.push(file);
		} else if (
			info.isFile() &&
			(info.mode & 0o777) === file.mode &&
			info.size === file.size &&
			(await digestFile(path)) === file.hash
		)
			result.push(file);
	}
	return result;
};
export const readSyncManifest = async (
	root: string,
	workspaceId: string,
): Promise<SyncManifest> => {
	const raw = JSON.parse(await readFile(join(root, SYNC_MARKER_FILE), "utf8"));
	if (raw.workspaceId !== workspaceId)
		throw new Error("This folder belongs to a different cloud workspace.");
	if (raw.version !== undefined && raw.version !== 1)
		throw new Error("Unsupported sync manifest version.");
	const files = raw.version === 1 ? raw.files : [];
	const pending = raw.version === 1 ? raw.pending : undefined;
	for (const list of [files, pending ?? []]) {
		if (!Array.isArray(list)) throw new Error("Invalid sync manifest.");
		for (const file of list) validateFile(file);
	}
	return { version: 1, workspaceId, files, ...(pending ? { pending } : {}) };
};
const validateFile = (raw: unknown): SyncFile => {
	if (typeof raw !== "object" || raw === null)
		throw new Error("Invalid snapshot entry.");
	const f = raw as Record<string, unknown>;
	if (
		typeof f.path !== "string" ||
		!validSyncPath(f.path) ||
		(f.stamp !== undefined &&
			(typeof f.stamp !== "string" || !/^[0-9:]{1,256}$/u.test(f.stamp))) ||
		typeof f.hash !== "string" ||
		!/^[a-f0-9]{64}$/u.test(f.hash) ||
		typeof f.mode !== "number" ||
		!Number.isInteger(f.mode) ||
		f.mode < 0 ||
		f.mode > 0o777 ||
		typeof f.size !== "number" ||
		!Number.isSafeInteger(f.size) ||
		f.size < 0 ||
		(f.link !== undefined &&
			(typeof f.link !== "string" || f.link.includes("\0") || f.size !== 0))
	)
		throw new Error("Invalid snapshot entry.");
	return {
		path: f.path,
		hash: f.hash,
		mode: f.mode,
		size: f.size,
		...(typeof f.link === "string" ? { link: f.link } : {}),
		...(typeof f.stamp === "string" ? { stamp: f.stamp } : {}),
	};
};
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

export async function cachedBaseline(cache: string): Promise<SyncFile[]> {
	const journal = await readFile(join(cache, "received.ndjson"), "utf8").catch(
		(cause: NodeJS.ErrnoException) => {
			if (cause.code === "ENOENT") return "";
			throw cause;
		},
	);
	const entries = new Map<string, SyncFile>();
	for (const line of journal.split("\n")) {
		if (!line) continue;
		try {
			const file = validateFile(JSON.parse(line));
			entries.set(file.path, file);
		} catch {
			/* A crash can truncate the last journal record. */
		}
	}
	const verified: SyncFile[] = [];
	for (const file of entries.values()) {
		if (file.link !== undefined) continue;
		const object = join(cache, "objects", file.hash);
		const info = await exists(object);
		if (
			info?.isFile() &&
			info.size === file.size &&
			(await digestFile(object)) === file.hash
		)
			verified.push(file);
	}
	return verified;
}

export async function downloadSnapshot(
	input: {
		hostAlias: string;
		remotePath: string;
		readRemoteFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
	},
	staging: string,
	baseline: SyncFile[],
	signal: AbortSignal,
	onProgress?: (progress: {
		files: number;
		total: number;
		bytes: number;
	}) => void,
): Promise<SyncFile[]> {
	const transferAbort = new AbortController();
	const child = spawn(
		"ssh",
		[
			"-C",
			"-F",
			cloudSshConfigPath(),
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=15",
			input.hostAlias,
			`python3 -c ${quote(input.readRemoteFile ? ARCHIVE_SNAPSHOT_SCRIPT : SNAPSHOT_SCRIPT)} ${quote(input.remotePath)}`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	let failure: Error | null = null;
	let forced: NodeJS.Timeout | undefined;
	const abort = () => {
		transferAbort.abort();
		child.kill("SIGTERM");
		forced ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
	};
	let timer: NodeJS.Timeout | undefined;
	const touch = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			failure = new Error("Cloud snapshot timed out without progress.");
			abort();
		}, 60_000);
	};
	const completed = new Promise<number | null>((resolve) => {
		child.once("error", (cause) => {
			failure = cause;
		});
		child.once("close", resolve);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-4096);
	});
	child.stdin.on("error", () => {});
	if (input.readRemoteFile)
		child.stdin.write(
			`${JSON.stringify({ script: SNAPSHOT_SCRIPT, root: input.remotePath, baseline: gzipSync(Buffer.from(JSON.stringify(baseline)), { level: 1 }).toString("base64") })}\n`,
		);
	else child.stdin.end(JSON.stringify(baseline));

	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	touch();
	const incoming = async function* () {
		if (!input.readRemoteFile) {
			yield* child.stdout;
			return;
		}
		let descriptor = "";
		for await (const chunk of child.stdout.iterator({
			destroyOnReturn: false,
		})) {
			descriptor += chunk.toString();
			if (descriptor.length > 262144)
				throw new Error("Snapshot descriptor too large.");
			if (descriptor.includes("\n")) break;
		}
		if (!descriptor)
			throw new Error(stderr.trim() || "Could not prepare snapshot archive.");
		const { parts } = JSON.parse(descriptor);
		if (
			!Array.isArray(parts) ||
			parts.length === 0 ||
			!parts.every(
				(path) =>
					typeof path === "string" &&
					/^\/tmp\/zuse-sync-[A-Za-z0-9_-]+\/part-\d+$/.test(path),
			)
		)
			throw new Error("Invalid snapshot archive descriptor.");
		const read = input.readRemoteFile;
		const chunks = async function* () {
			// Two bounded reads overlap gateway latency without accumulating the archive.
			const load = (path: string) =>
				read(path, transferAbort.signal).then(
					(bytes) => ({ ok: true as const, bytes }),
					(cause) => ({ ok: false as const, cause }),
				);
			const pending = parts.slice(0, 2).map(load);
			let next = pending.length;
			while (pending.length > 0) {
				if (transferAbort.signal.aborted) throw new Error("Sync cancelled.");
				const result = await pending.shift();
				if (!result) break;
				if (!result.ok) throw result.cause;
				if (result.bytes.length > 4 * 1024 * 1024)
					throw new Error("Snapshot part exceeds transfer limit.");
				if (next < parts.length) pending.push(load(parts[next++]));
				touch();
				yield result.bytes;
			}
		};
		yield* Readable.from(chunks()).compose(createGunzip());
		child.stdin.end("done\n");
		child.stdout.resume();
	};
	const iterator = incoming()[Symbol.asyncIterator]();
	let buffer = Buffer.alloc(0);
	const take = async (size: number): Promise<Buffer> => {
		while (buffer.length === 0) {
			const next = await iterator.next();
			if (next.done) throw new Error("Incomplete cloud snapshot.");
			buffer = Buffer.from(next.value);
			touch();
		}
		const part = buffer.subarray(0, size);
		buffer = buffer.subarray(part.length);
		return part;
	};
	const line = async (): Promise<string> => {
		const parts: Buffer[] = [];
		let size = 0;
		while (true) {
			const part = await take(262144);
			const end = part.indexOf(10);
			const text = end < 0 ? part : part.subarray(0, end);
			parts.push(text);
			size += text.length;
			if (size > 262144) throw new Error("Snapshot header too large.");
			if (end >= 0) {
				buffer = Buffer.concat([part.subarray(end + 1), buffer]);
				return Buffer.concat(parts).toString("utf8");
			}
		}
	};
	const files: SyncFile[] = [];
	let total = 0;
	let bytes = 0;
	let received = 0;
	const report = () => onProgress?.({ files: received, total, bytes });
	const seen = new Set<string>();
	const parents = new Set<string>();
	const baselineByPath = new Map(baseline.map((f) => [f.path, f]));
	try {
		while (true) {
			const raw = JSON.parse(await line());
			if (raw.done === true) break;
			if (raw.progress === true) continue;
			if (Number.isSafeInteger(raw.totalFiles) && raw.totalFiles >= 0) {
				total = raw.totalFiles;
				report();
				continue;
			}
			const file = validateFile(raw);
			if (seen.has(file.path) || parents.has(file.path))
				throw new Error("Conflicting snapshot path.");
			let parent = dirname(file.path);
			while (parent !== ".") {
				if (seen.has(parent)) throw new Error("Conflicting snapshot ancestor.");
				parents.add(parent);
				parent = dirname(parent);
			}
			seen.add(file.path);
			files.push(file);
			const target = join(staging, "objects", file.hash);
			if (file.link !== undefined) {
				if (
					raw.content !== false ||
					createHash("sha256").update(file.link).digest("hex") !== file.hash
				)
					throw new Error("Invalid snapshot symlink.");
			} else if (raw.content === true) {
				await mkdir(dirname(target), { recursive: true });
				const temporary = `${target}.partial`;
				const output = await open(temporary, "w", 0o600);
				const digest = createHash("sha256");
				try {
					let remaining = file.size;
					while (remaining > 0) {
						const part = await take(Math.min(remaining, 262144));
						digest.update(part);
						let offset = 0;
						while (offset < part.length)
							offset += (await output.write(part.subarray(offset)))
								.bytesWritten;
						remaining -= part.length;
						bytes += part.length;
						report();
					}
				} finally {
					await output.close();
				}
				if (digest.digest("hex") !== file.hash)
					throw new Error(`Snapshot checksum mismatch: ${file.path}`);
				await rename(temporary, target);
			} else if (
				raw.content !== false ||
				baselineByPath.get(file.path)?.hash !== file.hash ||
				baselineByPath.get(file.path)?.size !== file.size ||
				baselineByPath.get(file.path)?.mode !== file.mode ||
				baselineByPath.get(file.path)?.link !== undefined
			)
				throw new Error("Snapshot omitted required content.");
			received++;
			report();
			await appendFile(
				join(staging, "received.ndjson"),
				`${JSON.stringify(file)}\n`,
			);
		}
		// Drain to EOF so the subprocess can close, rejecting anything after done.
		if (buffer.length > 0) throw new Error("Trailing snapshot data.");
		for await (const extra of { [Symbol.asyncIterator]: () => iterator })
			if (extra.length > 0) throw new Error("Trailing snapshot data.");
		const code = await completed;
		if (signal.aborted) throw new Error("Sync cancelled.");
		if (failure !== null) throw failure;
		if (code !== 0) throw new Error(stderr.trim() || "Cloud snapshot failed.");
		await writeFile(
			join(staging, "received.next"),
			`${files.map((file) => JSON.stringify(file)).join("\n")}\n`,
		);
		await rename(
			join(staging, "received.next"),
			join(staging, "received.ndjson"),
		);
		const hashes = new Set(
			files.filter((file) => file.link === undefined).map((file) => file.hash),
		);
		for (const name of await readdir(join(staging, "objects")).catch(
			() => [],
		)) {
			if (!hashes.has(name))
				await rm(join(staging, "objects", name), { force: true });
		}
		return files;
	} catch (cause) {
		// Cancelling the producer can emit its own diagnostics. Capture the
		// transfer failure before cleanup so those cannot replace its cause.
		const transferFailure =
			failure ?? (stderr.trim() ? new Error(stderr.trim()) : cause);
		abort();
		await completed;
		throw transferFailure;
	} finally {
		clearTimeout(timer);
		clearTimeout(forced);
		signal.removeEventListener("abort", abort);
	}
}

export const writeSyncManifest = async (
	root: string,
	manifest: SyncManifest,
): Promise<void> => {
	// The marker is the only metadata kept in the checkout. Write elsewhere so
	// watchers never observe chunked metadata writes either.
	const temporary = `${root}.manifest-${process.pid}`;
	try {
		await writeFile(temporary, JSON.stringify(manifest));
		await rename(temporary, join(root, SYNC_MARKER_FILE));
	} finally {
		await rm(temporary, { force: true });
	}
};

export async function applySnapshot(
	root: string,
	staging: string,
	previous: SyncManifest,
	files: SyncFile[],
	signal: AbortSignal,
): Promise<void> {
	const next = new Map(files.map((f) => [f.path, f]));
	const owned = new Set(
		[...previous.files, ...(previous.pending ?? [])].map((f) => f.path),
	);
	const removed: string[] = [];
	for (const path of owned) {
		if (next.has(path)) continue;
		let parent = dirname(path);
		let alreadyReplaced = false;
		while (parent !== ".") {
			if (next.has(parent)) {
				const info = await exists(join(root, parent));
				if (info && !info.isDirectory()) alreadyReplaced = true;
			}
			parent = dirname(parent);
		}
		if (!alreadyReplaced) removed.push(path);
	}
	const removing = new Set(removed);
	const replacedDirectories: string[] = [];
	const checkDirectory = async (path: string): Promise<void> => {
		for (const item of await readdir(join(root, path), {
			withFileTypes: true,
		})) {
			const child = `${path}/${item.name}`;
			if (item.isDirectory()) await checkDirectory(child);
			else if (!removing.has(child))
				throw new Error(`Sync would replace an unmanaged local file: ${child}`);
		}
		replacedDirectories.push(path);
	};
	const changes: SyncFile[] = [];
	for (const file of files) {
		await assertParents(root, file.path, removing);

		const current = await exists(join(root, file.path));
		if (current?.isDirectory()) await checkDirectory(file.path);
		if (
			file.link !== undefined &&
			current?.isSymbolicLink() &&
			(await readlink(join(root, file.path))) === file.link
		)
			continue;
		if (
			file.link === undefined &&
			current?.isFile() &&
			current.size === file.size &&
			(current.mode & 0o777) === file.mode &&
			(await digestFile(join(root, file.path))) === file.hash
		)
			continue;
		if (
			file.link === undefined &&
			(await digestFile(join(staging, "objects", file.hash))) !== file.hash
		)
			throw new Error("Missing or corrupt snapshot object.");
		changes.push(file);
	}
	for (const path of removed) {
		await assertParents(root, path);
		if ((await exists(join(root, path)))?.isDirectory())
			throw new Error(`Sync would delete a local directory: ${path}`);
	}
	if (signal.aborted) throw new Error("Sync cancelled.");
	if (
		changes.length === 0 &&
		removed.length === 0 &&
		!previous.pending &&
		JSON.stringify(previous.files) === JSON.stringify(files)
	)
		return;
	const publish = await mkdtemp(`${root}.publish-`);
	try {
		// Prepare every replacement outside the watched tree before changing live files.
		for (const file of changes) {
			if (signal.aborted) throw new Error("Sync cancelled.");
			const path = join(publish, file.path);
			await mkdir(dirname(path), { recursive: true });
			if (file.link !== undefined) await symlink(file.link, path);
			else {
				await copyFile(join(staging, "objects", file.hash), path);
				await chmod(path, file.mode);
			}
		}
		if (signal.aborted) throw new Error("Sync cancelled.");
		await writeSyncManifest(root, {
			...previous,
			pending: [
				...new Map(
					[...previous.files, ...(previous.pending ?? []), ...files].map(
						(f) => [f.path, f],
					),
				).values(),
			],
		});
		// Only completed, checksummed files reach the live tree. The pending ownership
		// journal lets the next scan repair a process interrupted during this phase.
		for (const path of removed.sort((a, b) => b.length - a.length)) {
			if (signal.aborted) throw new Error("Sync cancelled.");
			await rm(join(root, path), { force: true });
		}
		for (const path of replacedDirectories) await rmdir(join(root, path));
		for (const file of changes) {
			if (signal.aborted) throw new Error("Sync cancelled.");
			await mkdir(dirname(join(root, file.path)), { recursive: true });
			await rename(join(publish, file.path), join(root, file.path));
		}
		for (const path of removed) {
			let parent = dirname(path);
			while (parent !== ".") {
				try {
					await rmdir(join(root, parent));
				} catch {
					break;
				}
				parent = dirname(parent);
			}
		}
		await writeSyncManifest(root, {
			version: 1,
			workspaceId: previous.workspaceId,
			files,
		});
	} finally {
		await rm(publish, { recursive: true, force: true });
	}
}
