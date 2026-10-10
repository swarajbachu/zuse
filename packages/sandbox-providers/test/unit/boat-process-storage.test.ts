import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { boatProcessStorageCommand } from "../../src/boat-process-storage.ts";

const fixture = async (
	run: (f: {
		directory: string;
		source: string;
		destination: string;
		prepare: () => Promise<unknown>;
	}) => Promise<void>,
) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-boat-storage-"));
	const source = join(directory, "volatile");
	const destination = join(directory, "persistent/process-activations");
	await mkdir(join(directory, "varlib"));
	await mkdir(join(directory, "opt"));
	const encoded = boatProcessStorageCommand().match(
		/printf %s ([A-Za-z0-9+/=]+)/,
	)?.[1];
	if (!encoded) throw new Error("missing script");
	const script = Buffer.from(encoded, "base64")
		.toString()
		// Other fixture guests share this host's /proc during parallel tests.
		.replaceAll(
			"const info=fs.readFileSync",
			`if(!path.startsWith("${directory}/"))continue;const info=fs.readFileSync`,
		)
		.replaceAll("/srv/zuse", join(directory, "persistent"))
		.replaceAll("/var/lib/zuse-process-activations", source)
		.replaceAll("/var/lib/zuse", join(directory, "varlib"))
		.replaceAll("-o root -g root", "")
		.replaceAll('-o "$owner" -g "$owner"', "");
	try {
		await run({
			directory,
			source,
			destination,
			prepare: () => promisify(execFile)("bash", ["-c", script]),
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

test("cold restored ownership is reattached without changing its journal", async () =>
	fixture(async (f) => {
		await mkdir(f.destination, { recursive: true });
		await writeFile(join(f.destination, "owner"), "9 original\n");
		await f.prepare();
		await f.prepare();
		expect(await readlink(f.source)).toBe(f.destination);
		expect(await readFile(join(f.source, "owner"), "utf8")).toBe(
			"9 original\n",
		);
	}));

test("moves an existing ownership directory without merging its lock inodes", async () =>
	fixture(async (f) => {
		await mkdir(f.source);
		await writeFile(join(f.source, "owner"), "4 previous\n");
		await f.prepare();
		expect(await readFile(join(f.destination, "owner"), "utf8")).toBe(
			"4 previous\n",
		);
		expect(await readlink(f.source)).toBe(f.destination);
	}));

test("two populated ownership roots fail closed and remain unchanged", async () =>
	fixture(async (f) => {
		await mkdir(f.source);
		await mkdir(f.destination, { recursive: true });
		await writeFile(join(f.source, "owner"), "5 current\n");
		await writeFile(join(f.destination, "owner"), "4 previous\n");
		await expect(f.prepare()).rejects.toBeDefined();
		expect(await readFile(join(f.source, "owner"), "utf8")).toBe("5 current\n");
		expect(await readFile(join(f.destination, "owner"), "utf8")).toBe(
			"4 previous\n",
		);
	}));

test("a live unaccounted SQLite writer prevents path migration", async () =>
	fixture(async (f) => {
		await mkdir(f.source);
		await writeFile(join(f.source, "owner"), "5 current\n");
		const writer = await open(join(f.directory, "zuse.sqlite"), "w+");
		try {
			await expect(f.prepare()).rejects.toBeDefined();
			expect(await readFile(join(f.source, "owner"), "utf8")).toBe(
				"5 current\n",
			);
			await expect(readlink(f.source)).rejects.toBeDefined();
		} finally {
			await writer.close();
		}
		await f.prepare();
		expect(await readlink(f.source)).toBe(f.destination);
	}));

test("restores the update journal without moving provider-persisted releases", async () =>
	fixture(async (f) => {
		const update = join(f.directory, "persistent/runtime-update");
		const releases = join(f.directory, "opt/zuse/releases/previous");
		await mkdir(update, { recursive: true });
		await mkdir(releases, { recursive: true });
		await writeFile(join(update, "transaction.json"), '{"phase":"prepared"}');
		await writeFile(join(releases, "bin.mjs"), "previous release");
		const original = await stat(releases);
		const writer = await open(join(f.directory, "zuse.sqlite"), "w+");
		try {
			await f.prepare();
		} finally {
			await writer.close();
		}
		expect((await stat(releases)).ino).toBe(original.ino);
		await expect(readlink(join(f.directory, "opt/zuse"))).rejects.toBeDefined();
		expect(await readlink(join(f.directory, "varlib/runtime-update"))).toBe(
			update,
		);
		expect(
			await readFile(
				join(f.directory, "opt/zuse/releases/previous/bin.mjs"),
				"utf8",
			),
		).toBe("previous release");
		expect(
			await readFile(
				join(f.directory, "varlib/runtime-update/transaction.json"),
				"utf8",
			),
		).toBe('{"phase":"prepared"}');
	}));

test("fresh canonical data and restored legacy SQLite share one persistent authority", async () =>
	fixture(async (f) => {
		const canonical = join(f.directory, "varlib/user-data");
		const retained = join(f.directory, "persistent/home/.zuse-data");
		await mkdir(retained, { recursive: true });
		await writeFile(join(retained, "zuse.sqlite"), "retained database");
		await writeFile(join(retained, "zuse.sqlite-wal"), "retained WAL");
		await f.prepare();
		expect(await readlink(canonical)).toBe(retained);
		expect(await readFile(join(canonical, "zuse.sqlite"), "utf8")).toBe(
			"retained database",
		);
		// A cold boot discards the volatile alias, never the persisted bytes.
		await rm(canonical);
		await f.prepare();
		expect(await readlink(canonical)).toBe(retained);
		expect(await readFile(join(canonical, "zuse.sqlite-wal"), "utf8")).toBe(
			"retained WAL",
		);
	}));

test("distinct populated canonical and persisted databases are never merged", async () =>
	fixture(async (f) => {
		const canonical = join(f.directory, "varlib/user-data");
		const retained = join(f.directory, "persistent/home/.zuse-data");
		await mkdir(canonical);
		await mkdir(retained, { recursive: true });
		await writeFile(join(canonical, "zuse.sqlite"), "canonical database");
		await writeFile(join(retained, "zuse.sqlite"), "retained database");
		await expect(f.prepare()).rejects.toBeDefined();
		expect(await readFile(join(canonical, "zuse.sqlite"), "utf8")).toBe(
			"canonical database",
		);
		expect(await readFile(join(retained, "zuse.sqlite"), "utf8")).toBe(
			"retained database",
		);
	}));

test("retains an existing release alias without copying or replacing it", async () =>
	fixture(async (f) => {
		const releases = join(f.directory, "persistent/previous-release-location");
		const alias = join(f.directory, "opt/zuse");
		await mkdir(releases, { recursive: true });
		await writeFile(join(releases, "retained-release"), "signed release bytes");
		await symlink(releases, alias);
		await f.prepare();
		expect(await readlink(alias)).toBe(releases);
		expect(await readFile(join(alias, "retained-release"), "utf8")).toBe(
			"signed release bytes",
		);
	}));
