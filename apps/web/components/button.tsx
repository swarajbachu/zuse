"use client";
import { DitherButtonBackground } from "@repo/ui/dither";
import { useWebsiteMessages } from "@zuse/i18n/website/react";

import Link from "next/link";
import type { ReactNode } from "react";
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
	icon,
	containerClassName,
}: {
	text?: string;
	href?: string;
	showIcon?: boolean;
	icon?: ReactNode;
	containerClassName?: string;
}) => {
	const { message: t } = useWebsiteMessages();
	const platform = useDownloadPlatform();
	const usesAutomaticDownload = href === DOWNLOAD_URL;
	const resolvedHref = usesAutomaticDownload ? getDownloadHref(platform) : href;
	const resolvedText = text ?? getDownloadLabel(platform, t);
	const external = href.startsWith("http");
	return (
		<Link
			href={resolvedHref}
			{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
			aria-label={resolvedText}
			aria-keyshortcuts={usesAutomaticDownload ? "D" : undefined}
			className={cn(
				"group relative isolate flex min-h-11 w-fit min-w-52 cursor-pointer items-center gap-3 overflow-hidden rounded-lg bg-background px-4 py-2 font-mono text-sm font-bold text-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				containerClassName,
			)}
		>
			<DitherButtonBackground />
			{showIcon &&
				(icon ?? (
					<PlatformDownloadIcon
						platform={platform}
						className="size-5 shrink-0"
					/>
				))}
			<span className="relative flex w-full items-center justify-between gap-3">
				<span className="[text-shadow:0_1px_3px_var(--color-background)]">
					{resolvedText}
				</span>
				{usesAutomaticDownload ? (
					<kbd className="rounded bg-background/30 px-1.5 py-1 font-mono text-[10px] leading-none opacity-65">
						D
					</kbd>
				) : null}
			</span>
		</Link>
	);
};
