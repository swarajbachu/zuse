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
			<path d="M14 7h8v1h-8zM12 8h2v1h-2zM16 8h1v1h-1zM20 8h1v1h-1zM22 8h2v1h-2zM11 9h1v1h-1zM24 9h1v1h-1zM10 10h1v1h-1zM18 10h1v1h-1zM22 10h1v1h-1zM24 10h2v1h-2zM10 11h1v1h-1zM23 11h1v1h-1zM25 11h2v1h-2zM9 12h1v1h-1zM12 12h1v1h-1zM16 12h1v1h-1zM20 12h1v1h-1zM22 12h1v1h-1zM24 12h3v1h-3zM9 13h1v1h-1zM21 13h1v1h-1zM23 13h1v1h-1zM25 13h1v1h-1zM27 13h3v1h-3zM9 14h1v1h-1zM14 14h1v1h-1zM20 14h1v1h-1zM22 14h3v1h-3zM26 14h1v1h-1zM30 14h2v1h-2zM9 15h1v1h-1zM21 15h1v1h-1zM23 15h1v1h-1zM25 15h1v1h-1zM31 15h2v1h-2zM8 16h1v1h-1zM10 16h1v1h-1zM12 16h1v1h-1zM16 16h1v1h-1zM18 16h1v1h-1zM20 16h5v1h-5zM26 16h1v1h-1zM28 16h1v1h-1zM30 16h1v1h-1zM32 16h1v1h-1zM6 17h2v1h-2zM17 17h1v1h-1zM19 17h7v1h-7zM29 17h1v1h-1zM31 17h3v1h-3zM5 18h1v1h-1zM10 18h1v1h-1zM12 18h1v1h-1zM14 18h1v1h-1zM16 18h1v1h-1zM18 18h7v1h-7zM26 18h1v1h-1zM28 18h1v1h-1zM30 18h4v1h-4zM4 19h1v1h-1zM13 19h1v1h-1zM15 19h1v1h-1zM17 19h3v1h-3zM21 19h3v1h-3zM27 19h1v1h-1zM29 19h7v1h-7zM3 20h2v1h-2zM8 20h1v1h-1zM12 20h13v1h-13zM26 20h1v1h-1zM28 20h7v1h-7zM36 20h1v1h-1zM3 21h1v1h-1zM13 21h11v1h-11zM25 21h1v1h-1zM27 21h7v1h-7zM37 21h1v1h-1zM3 22h1v1h-1zM6 22h1v1h-1zM10 22h1v1h-1zM12 22h21v1h-21zM34 22h1v1h-1zM36 22h2v1h-2zM3 23h1v1h-1zM11 23h5v1h-5zM17 23h7v1h-7zM25 23h7v1h-7zM35 23h4v1h-4zM3 24h2v1h-2zM6 24h1v1h-1zM8 24h31v1h-31zM3 25h1v1h-1zM5 25h1v1h-1zM7 25h15v1h-15zM23 25h9v1h-9zM33 25h5v1h-5zM4 26h13v1h-13zM18 26h3v1h-3zM22 26h9v1h-9zM32 26h6v1h-6zM4 27h8v1h-8zM13 27h1v1h-1zM15 27h1v1h-1zM17 27h1v1h-1zM19 27h1v1h-1zM21 27h1v1h-1zM23 27h1v1h-1zM25 27h1v1h-1zM27 27h1v1h-1zM29 27h1v1h-1zM31 27h1v1h-1zM33 27h4v1h-4zM5 28h30v1h-30zM7 29h27v1h-27z" />
		</svg>
	);
}
