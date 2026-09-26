import { type DitherOptions, ditherPixels } from "@repo/ui/image-dither";

self.onmessage = (
	event: MessageEvent<{
		pixels: Uint8ClampedArray;
		width: number;
		height: number;
		options: DitherOptions;
	}>,
) => {
	const { pixels, width, height, options } = event.data;
	const result = ditherPixels(pixels, width, height, options);
	self.postMessage(
		{ pixels: result, width, height },
		{ transfer: [result.buffer] },
	);
};
