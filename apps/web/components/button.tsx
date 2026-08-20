"use client";

import Link from "next/link";
import {
	getDownloadHref,
	getDownloadLabel,
	PlatformDownloadIcon,
	useDownloadPlatform,
} from "@/components/platform-download";
import { DOWNLOAD_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * Primary CTA. The default route selects the latest installer for the
 * visitor's OS while keeping the visible label stable during hydration.
 */
export const Button = ({
	text,
	href = DOWNLOAD_URL,
	showIcon = true,
	containerClassName,
}: {
	text?: string;
	href?: string;
	showIcon?: boolean;
	containerClassName?: string;
}) => {
	const platform = useDownloadPlatform();
	const usesAutomaticDownload = href === DOWNLOAD_URL;
	const resolvedHref = usesAutomaticDownload ? getDownloadHref(platform) : href;
	const resolvedText = text ?? getDownloadLabel(platform);
	const external = href.startsWith("http");
	return (
		<Link
			href={resolvedHref}
			{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
			aria-label={resolvedText}
			aria-keyshortcuts={usesAutomaticDownload ? "D" : undefined}
			className={cn(
				"group relative flex min-h-11 w-fit min-w-52 cursor-pointer items-center gap-2 rounded-lg border border-white/20 bg-black py-2 pr-3 pl-11 tracking-tight",
				containerClassName,
			)}
		>
			<Box platform={platform} showIcon={showIcon} />
			<div className="absolute -inset-px rounded-lg bg-white/15 transition-[clip-path] duration-400 ease-out [clip-path:inset(0_100%_0_0)] group-hover:[clip-path:inset(0_0%_0_0)]" />
			<span className="relative flex w-full items-center justify-between gap-3 text-white transition-transform duration-400 group-hover:-translate-x-8">
				<span>{resolvedText}</span>
				{usesAutomaticDownload ? (
					<kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-sans text-[10px] leading-none text-white/70">
						D
					</kbd>
				) : null}
			</span>
		</Link>
	);
};

const Box = ({
	platform,
	showIcon,
}: {
	platform: ReturnType<typeof useDownloadPlatform>;
	showIcon?: boolean;
}) => {
	return (
		<div
			data-slot="button-box"
			className="bg-primary absolute inset-y-0 left-1 z-40 my-auto flex size-8 items-center justify-center rounded-[5px] transition-[left,transform] duration-400 ease-out group-hover:left-[calc(100%-2.3rem)] group-hover:rotate-180"
		>
			{showIcon && (
				<PlatformDownloadIcon
					platform={platform}
					className="size-5 text-black transition-transform duration-400 ease-out group-hover:rotate-180"
				/>
			)}
		</div>
	);
};
