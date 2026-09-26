import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import Path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

import {
	validateDesktopMainBundle,
	validateDesktopPackageEntries,
} from "../src/package-content.ts";

const archiveArgument = process.argv[2];
if (archiveArgument === undefined) {
	throw new Error("Usage: package-content-smoke.ts <app.asar>");
}

const archivePath = Path.resolve(archiveArgument);
const entries = listPackage(archivePath);
validateDesktopPackageEntries(entries);
validateDesktopMainBundle(
	extractFile(archivePath, "dist-electron/main.cjs").toString("utf8"),
);
const resourcesRoot = Path.dirname(archivePath);
const cursorLicense = await readFile(
	Path.join(resourcesRoot, "app/licenses/Cursor-SDK.LICENSE.md"),
	"utf8",
);
if (!cursorLicense.includes("Cursor SDK License")) {
	throw new Error("Packaged Cursor SDK license is missing or invalid");
}
for (const executable of ["cursorsandbox", "rg"]) {
	await access(
		Path.join(
			`${archivePath}.unpacked`,
			"node_modules/@cursor/sdk/node_modules/@cursor/sdk-linux-x64/bin",
			executable,
		),
		constants.X_OK,
	);
}
console.log(
	`Desktop package content smoke passed (${entries.length} ASAR entries).`,
);
