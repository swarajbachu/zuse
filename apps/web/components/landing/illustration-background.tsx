"use client";

import { ReactBitsDither } from "@repo/ui/react-bits-dither";

/** A quiet presentation for product diagrams; the full shader stays unchanged. */
export function IllustrationBackground() {
	return (
		<ReactBitsDither className="absolute inset-0 -z-10 opacity-[0.14] grayscale" />
	);
}
