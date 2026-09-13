import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readPreference<T>(
	directory: string,
	file: string,
	decode: (value: unknown) => T,
): Promise<T> {
	try {
		return decode(JSON.parse(await readFile(join(directory, file), "utf8")));
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT")
		)
			return decode(null);
		throw error;
	}
}

export async function writePreference(
	directory: string,
	file: string,
	value: unknown,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	const destination = join(directory, file);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
}
