import { existsSync } from "node:fs";
import { sep } from "node:path";

/** Child processes and native tools need physical paths outside Electron ASAR. */
export const unpackedPath = (path: string): string => {
	const unpacked = path.replace(
		`${sep}app.asar${sep}`,
		`${sep}app.asar.unpacked${sep}`,
	);
	return existsSync(unpacked) ? unpacked : path;
};
