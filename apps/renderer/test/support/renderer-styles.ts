import { readFileSync } from "node:fs";

/** Resolve the shared palette aliases so color assertions test their values. */
export const rendererStylesWithPalette = (): string => {
	const styles = readFileSync(
		new URL("../../src/styles.css", import.meta.url),
		"utf8",
	);
	if (!styles.includes('@import "@repo/ui/app-palette.css"')) {
		throw new Error("Renderer must import the shared application palette");
	}
	const palette = readFileSync(
		new URL("../../../../packages/ui/src/app-palette.css", import.meta.url),
		"utf8",
	);
	const values = new Map(
		[...palette.matchAll(/(--app-[\w-]+):\s*([^;]+);/g)].map((match) => [
			match[1],
			match[2],
		]),
	);
	return styles.replace(/var\((--app-[\w-]+)\)/g, (_, key: string) => {
		const value = values.get(key);
		if (value === undefined) throw new Error(`Missing palette token: ${key}`);
		return value;
	});
};
