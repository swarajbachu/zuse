/** Shared, bounded raster-image decoding for browser upload surfaces. */
export const IMAGE_ACCEPT =
	"image/png,image/jpeg,image/webp,image/avif,image/gif";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2560;

export async function readImageFile(file: Blob): Promise<HTMLCanvasElement> {
	if (!IMAGE_ACCEPT.split(",").includes(file.type)) {
		throw new Error("Choose a PNG, JPEG, WebP, AVIF, or GIF image.");
	}
	if (file.size > MAX_IMAGE_BYTES)
		throw new Error("Choose an image smaller than 20 MB.");
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const scale = Math.min(
			1,
			MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
		);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const context = canvas.getContext("2d");
		if (!context)
			throw new Error("Image processing is unavailable in this browser.");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return canvas;
	} catch (error) {
		if (error instanceof Error && error.name !== "EncodingError") throw error;
		throw new Error("This image could not be read. Try another file.");
	} finally {
		URL.revokeObjectURL(url);
	}
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) =>
				blob
					? resolve(blob)
					: reject(
							new Error("Could not export this image. Try a smaller file."),
						),
			"image/png",
		);
	});
}
