import { DITHER_CLOUD_PATH } from "@zuse/icons/dither-cloud";
import { cn } from "~/lib/utils";

/** The supplied 40px single-color dither cloud, kept on its original pixel grid. */
export function DitherCloudIcon({
	className,
}: {
	readonly className?: string;
}) {
	return (
		<svg
			viewBox="0 0 40 40"
			fill="currentColor"
			shapeRendering="crispEdges"
			className={cn("size-4 shrink-0", className)}
			aria-hidden="true"
		>
			<path d={DITHER_CLOUD_PATH} />
		</svg>
	);
}
