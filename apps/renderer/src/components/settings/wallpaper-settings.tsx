import "@zuse/i18n/english/settings";
import { IMAGE_ACCEPT } from "@repo/ui/image-file";
import { useMessages } from "@zuse/i18n/react";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { SettingsRow } from "~/components/ui/settings-panel";
import {
	removeWallpaper,
	setWallpaperOpacity,
	uploadWallpaper,
	useWallpaper,
} from "~/lib/wallpaper";
import { MAX_WALLPAPER_OPACITY } from "~/lib/wallpaper-image";

export function WallpaperSettings() {
	const { message } = useMessages(["settings"]);
	const wallpaper = useWallpaper();
	const input = useRef<HTMLInputElement>(null);
	const [draftOpacity, setDraftOpacity] = useState<number | null>(null);
	return (
		<SettingsRow
			title={message("settings:wallpaper_title")}
			description={message("settings:wallpaper_description")}
			action={
				<div className="flex items-center gap-2">
					<Button
						className="h-7"
						variant="outline"
						disabled={wallpaper.busy || !wallpaper.loaded}
						onClick={() => input.current?.click()}
					>
						{wallpaper.busy
							? message("settings:wallpaper_saving")
							: wallpaper.url
								? message("settings:wallpaper_replace")
								: message("settings:wallpaper_upload")}
					</Button>
					{wallpaper.url && (
						<Button
							className="h-7"
							variant="ghost"
							disabled={wallpaper.busy}
							onClick={() => void removeWallpaper()}
						>
							{message("settings:wallpaper_remove")}
						</Button>
					)}
				</div>
			}
		>
			<input
				ref={input}
				type="file"
				accept={IMAGE_ACCEPT}
				className="hidden"
				aria-label={message("settings:wallpaper_upload_label")}
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void uploadWallpaper(file);
				}}
			/>
			{wallpaper.url && (
				<div className="flex items-center gap-4 pb-1">
					<div
						aria-hidden="true"
						className="h-14 w-24 shrink-0 rounded-md bg-cover bg-center"
						style={{ backgroundImage: `url("${wallpaper.url}")` }}
					/>
					<label className="flex flex-1 items-center gap-3 text-xs text-muted-foreground">
						<span>{message("settings:wallpaper_opacity")}</span>
						<input
							aria-label={message("settings:wallpaper_opacity_label")}
							className="h-7 min-w-0 flex-1 accent-primary"
							type="range"
							min="0"
							max={MAX_WALLPAPER_OPACITY * 100}
							value={draftOpacity ?? Math.round(wallpaper.opacity * 100)}
							disabled={wallpaper.busy}
							onChange={(event) => setDraftOpacity(Number(event.target.value))}
							onBlur={() => {
								if (draftOpacity !== null) {
									void setWallpaperOpacity(draftOpacity / 100);
									setDraftOpacity(null);
								}
							}}
							onPointerUp={(event) => {
								void setWallpaperOpacity(
									Number(event.currentTarget.value) / 100,
								);
								setDraftOpacity(null);
							}}
							onKeyUp={(event) => {
								if (
									event.key.startsWith("Arrow") ||
									["Home", "End", "PageUp", "PageDown"].includes(event.key)
								) {
									void setWallpaperOpacity(
										Number(event.currentTarget.value) / 100,
									);
									setDraftOpacity(null);
								}
							}}
						/>
						<span className="w-8 text-right tabular-nums">
							{draftOpacity ?? Math.round(wallpaper.opacity * 100)}%
						</span>
					</label>
				</div>
			)}
			<p className="pb-1 text-[11px] text-muted-foreground">
				{message("settings:wallpaper_hint")}{" "}
				<a
					className="underline underline-offset-2"
					href="https://zuse.sh/tools/dither"
					target="_blank"
					rel="noreferrer"
				>
					{message("settings:wallpaper_studio")}
				</a>
				.
			</p>
			{wallpaper.error && (
				<p role="alert" className="pb-1 text-xs text-destructive">
					{wallpaper.error}
				</p>
			)}
		</SettingsRow>
	);
}
