"use client";

import Link from "next/link";
import { DOWNLOAD_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/**
 * Primary CTA. The default route selects the latest installer for the
 * visitor's OS while keeping the visible label stable during hydration.
 */
export const Button = ({
	text = "Download Zuse",
	href = DOWNLOAD_URL,
	showIcon = true,
	containerClassName,
}: {
	text?: string;
	href?: string;
	showIcon?: boolean;
	containerClassName?: string;
}) => {
	const external = href.startsWith("http");
	return (
		<Link
			href={href}
			{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
			className={cn(
				"group relative flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-white/20 bg-black py-2 pr-4 pl-11 tracking-tight",
				containerClassName,
			)}
		>
			<Box showIcon={showIcon} />
			<div className="absolute -inset-px rounded-lg bg-white/15 transition-[clip-path] duration-400 ease-out [clip-path:inset(0_100%_0_0)] group-hover:[clip-path:inset(0_0%_0_0)]" />
			<span className="inline-block text-white transition-transform duration-400 group-hover:-translate-x-8">
				{text}
			</span>
		</Link>
	);
};

const Box = ({ showIcon }: { showIcon?: boolean }) => {
	return (
		<div
			data-slot="button-box"
			className="bg-primary absolute inset-y-0 left-1 z-40 my-auto flex size-8 items-center justify-center rounded-[5px] transition-all duration-400 ease-out group-hover:left-[calc(100%-2.3rem)] group-hover:rotate-180 group-hover:transform"
		>
			{showIcon && (
				<DownloadIcon className="size-5 text-black transition-transform duration-400 ease-out group-hover:rotate-180" />
			)}
		</div>
	);
};

const DownloadIcon = ({ className }: { className?: string }) => {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			className={className}
			fill="currentColor"
		>
			<path d="M11 3a1 1 0 1 1 2 0v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.42l3.3 3.3V3ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z" />
		</svg>
	);
};
