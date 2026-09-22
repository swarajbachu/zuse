import type { ComponentType } from "react";

// Keep React Three Fiber's intrinsic-element augmentation inside the vendor
// implementation so it does not change DOM/MDX component types in consumers.
export type DitherProps = {
	waveSpeed?: number;
	waveFrequency?: number;
	waveAmplitude?: number;
	waveColor?: [number, number, number];
	backgroundColor?: [number, number, number];
	colorNum?: number;
	pixelSize?: number;
	disableAnimation?: boolean;
	enableMouseInteraction?: boolean;
	mouseRadius?: number;
};
declare const Dither: ComponentType<DitherProps>;
export default Dither;
