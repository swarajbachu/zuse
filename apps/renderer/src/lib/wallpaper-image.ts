import { renderDitherImage } from "@repo/ui/dither-image";
import type { DitherOptions } from "@repo/ui/image-dither";
import { canvasToBlob, readImageFile } from "@repo/ui/image-file";

export const WALLPAPER_PROCESSING_VERSION = 3;
export const DEFAULT_WALLPAPER_OPACITY = 0.5;
export const MAX_WALLPAPER_OPACITY = 0.8;
export const WALLPAPER_DITHER_OPTIONS: DitherOptions = {
	algorithm: "cross-6",
	palette: "color",
	pixelSize: 2,
	contrast: 135,
	brightness: -8,
	strength: 100,
	blur: 0,
};

export async function prepareWallpaper(source: Blob): Promise<Blob> {
	return canvasToBlob(
		await renderDitherImage(
			await readImageFile(source),
			WALLPAPER_DITHER_OPTIONS,
		),
	);
}
