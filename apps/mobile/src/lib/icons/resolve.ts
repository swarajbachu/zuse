import { basename } from "../workspace-path";
import {
	FILE_ICON_EXTENSIONS,
	FILE_ICON_FILE_NAMES,
} from "./file-icons.generated";

/** Mirrors the structured file tree's longest-extension-first resolution. */
export const resolveFileIconToken = (filePath: string): string => {
	const fileName = basename(filePath).toLowerCase();
	const named = FILE_ICON_FILE_NAMES[fileName];
	if (named !== undefined) return named;
	const segments = fileName.split(".");
	for (let index = 1; index < segments.length; index += 1) {
		const token = FILE_ICON_EXTENSIONS[segments.slice(index).join(".")];
		if (token !== undefined) return token;
	}
	return "default";
};
