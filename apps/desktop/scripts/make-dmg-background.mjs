// Compose the wallpaper and editable typography into Finder's background.
// electron-builder combines the 1x and 2x PNGs into a Retina TIFF on macOS.
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const wallpaper = fileURLToPath(
	new URL("../build/dmg-wallpaper.png", import.meta.url),
);
const overlay = fileURLToPath(
	new URL("../build/dmg-background.svg", import.meta.url),
);
for (const scale of [1, 2]) {
	const output = new URL(
		`../build/dmg-background${scale === 2 ? "@2x" : ""}.png`,
		import.meta.url,
	);
	const typography = await sharp(overlay, { density: 72 * scale })
		.png()
		.toBuffer();
	await sharp(wallpaper)
		.resize(640 * scale, 440 * scale, { fit: "cover" })
		.composite([{ input: typography }])
		.png()
		.toFile(fileURLToPath(output));
}
