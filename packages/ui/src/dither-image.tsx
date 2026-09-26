import type { DitherOptions } from "@repo/ui/image-dither";

/** One bounded, cancellable rendering path for the studio and desktop wallpaper. */
export function renderDitherImage(
	source: HTMLCanvasElement,
	options: DitherOptions,
	signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Rendering cancelled", "AbortError"));
			return;
		}
		let worker: Worker | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			worker?.terminate();
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		};
		const fail = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const abort = () =>
			fail(new DOMException("Rendering cancelled", "AbortError"));
		try {
			const sample = document.createElement("canvas");
			sample.width = Math.max(1, Math.ceil(source.width / options.pixelSize));
			sample.height = Math.max(1, Math.ceil(source.height / options.pixelSize));
			const context = sample.getContext("2d", { willReadFrequently: true });
			if (!context) throw new Error("Image processing is unavailable.");
			context.filter = `blur(${options.blur / options.pixelSize}px)`;
			context.drawImage(source, 0, 0, sample.width, sample.height);
			const input = context.getImageData(0, 0, sample.width, sample.height);
			worker = new Worker(
				new URL("./image-dither.worker.ts", import.meta.url),
				{ type: "module" },
			);
			signal?.addEventListener("abort", abort, { once: true });
			timeout = setTimeout(
				() =>
					fail(new Error("Image processing timed out. Try a smaller image.")),
				30_000,
			);
			worker.onmessage = (
				event: MessageEvent<{
					pixels: Uint8ClampedArray<ArrayBuffer>;
					width: number;
					height: number;
				}>,
			) => {
				try {
					const { pixels, width, height } = event.data;
					context.putImageData(new ImageData(pixels, width, height), 0, 0);
					const canvas = document.createElement("canvas");
					canvas.width = source.width;
					canvas.height = source.height;
					const output = canvas.getContext("2d");
					if (!output) throw new Error("Image processing is unavailable.");
					output.imageSmoothingEnabled = false;
					output.drawImage(sample, 0, 0, canvas.width, canvas.height);
					cleanup();
					resolve(canvas);
				} catch (error) {
					fail(error);
				}
			};
			worker.onerror = () =>
				fail(new Error("Could not process this image. Try a smaller image."));
			worker.onmessageerror = () =>
				fail(new Error("Could not read the processed image. Try again."));
			worker.postMessage(
				{
					pixels: input.data,
					width: input.width,
					height: input.height,
					options,
				},
				[input.data.buffer],
			);
		} catch (error) {
			fail(error);
		}
	});
}
