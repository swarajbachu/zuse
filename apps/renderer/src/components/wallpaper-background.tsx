import { useWallpaper } from "~/lib/wallpaper";

/** A static layer that never captures input or changes the app's theme. */
export function WallpaperBackground() {
	const { url, opacity } = useWallpaper();
	if (!url) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 -z-10"
			style={{
				backgroundImage: `url("${url}")`,
				backgroundPosition: "center",
				backgroundSize: "cover",
				opacity,
				filter: "brightness(0.6)",
				maskImage:
					"linear-gradient(to bottom, black 0%, rgba(0,0,0,0.85) 38%, rgba(0,0,0,0.3) 72%, transparent 100%)",
			}}
		/>
	);
}
