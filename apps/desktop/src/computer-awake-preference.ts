import type { ComputerAwakeMode } from "@zuse/contracts";
import { readPreference, writePreference } from "./atomic-preference.ts";

const PREFERENCE_FILE = "computer-awake.json";
export const DEFAULT_COMPUTER_AWAKE_MODE: ComputerAwakeMode = "auto";

const isComputerAwakeMode = (value: unknown): value is ComputerAwakeMode =>
	value === "off" || value === "auto" || value === "always";

export const readComputerAwakePreference = async (
	userData: string,
): Promise<ComputerAwakeMode> => {
	try {
		const parsed = await readPreference(
			userData,
			PREFERENCE_FILE,
			(value) => value,
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
	await writePreference(userData, PREFERENCE_FILE, { mode });
};
