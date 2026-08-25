import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ComputerAwakeMode } from "@zuse/contracts";

const PREFERENCE_FILE = "computer-awake.json";
export const DEFAULT_COMPUTER_AWAKE_MODE: ComputerAwakeMode = "auto";

const preferencePath = (userData: string): string =>
	join(userData, PREFERENCE_FILE);

const isComputerAwakeMode = (value: unknown): value is ComputerAwakeMode =>
	value === "off" || value === "auto" || value === "always";

export const readComputerAwakePreference = async (
	userData: string,
): Promise<ComputerAwakeMode> => {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(preferencePath(userData), "utf8"),
		);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"mode" in parsed &&
			isComputerAwakeMode(parsed.mode)
		) {
			return parsed.mode;
		}
	} catch {
		// Missing and corrupt preferences intentionally use the product default.
	}
	return DEFAULT_COMPUTER_AWAKE_MODE;
};

export const writeComputerAwakePreference = async (
	userData: string,
	mode: ComputerAwakeMode,
): Promise<void> => {
	await mkdir(userData, { recursive: true });
	const destination = preferencePath(userData);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ mode }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, destination);
};
