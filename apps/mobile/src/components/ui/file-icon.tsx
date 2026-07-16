import { memo } from "react";
import { SvgXml } from "react-native-svg";

import {
	FILE_ICON_LOOKUP,
	ICON_XML,
} from "~/lib/icons/material-icon-xml.generated";
import { basename, resolveFileIconName } from "~/lib/icons/resolve";

/**
 * Real per-file-type icon (Material Icon Theme), matching the desktop/web app.
 * The path → icon-name resolution mirrors the desktop resolver (see
 * `~/lib/icons/resolve`); the SVGs are baked into
 * `material-icon-xml.generated.ts` and rendered
 * synchronously through react-native-svg, so rows paint an icon on first render
 * with no flicker.
 */
export const FileIcon = memo(function FileIcon({
	path,
	size = 14,
}: {
	path: string;
	size?: number;
}) {
	const name = resolveFileIconName(basename(path), FILE_ICON_LOOKUP);
	const xml = ICON_XML[name] ?? ICON_XML[FILE_ICON_LOOKUP.defaultFile];
	if (xml === undefined) return null;
	return <SvgXml xml={xml} width={size} height={size} />;
});
