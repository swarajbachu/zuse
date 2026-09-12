"use client";
import {
	IconBrandAppleFilled,
	IconDownload,
	IconTerminal2,
} from "@tabler/icons-react";
import type { WebsiteMessage } from "@zuse/i18n/website/react";
import { useEffect, useState } from "react";
import { resolveDownloadTarget } from "@/lib/download";
import { DOWNLOAD_URL } from "@/lib/site";

export type DownloadPlatform = "detecting" | "macos" | "linux" | "other";

export const useDownloadPlatform = () => {
	const [platform, setPlatform] = useState<DownloadPlatform>("detecting");

	useEffect(() => {
		const target = resolveDownloadTarget({
			platform: null,
			format: null,
			userAgent: navigator.userAgent,
		});

		if (target === "macos") {
			setPlatform("macos");
			return;
		}

		if (target?.startsWith("linux")) {
			setPlatform("linux");
			return;
		}

		setPlatform("other");
	}, []);

	return platform;
};

export const getDownloadHref = (platform: DownloadPlatform) => {
	if (platform === "macos") return `${DOWNLOAD_URL}?platform=macos`;
	if (platform === "linux") return `${DOWNLOAD_URL}?platform=linux`;
	return DOWNLOAD_URL;
};

export const getDownloadLabel = (
	platform: DownloadPlatform,
	t: WebsiteMessage,
) => {
	if (platform === "macos") return t("navigation:download_for_macos");
	if (platform === "linux") return t("navigation:download_for_linux");
	if (platform === "other") return t("navigation:view_downloads");
	return t("navigation:download_zuse");
};

export const PlatformDownloadIcon = ({
	platform,
	className,
}: {
	platform: DownloadPlatform;
	className?: string;
}) => {
	if (platform === "macos") {
		return <IconBrandAppleFilled aria-hidden="true" className={className} />;
	}

	if (platform === "linux") {
		return <IconTerminal2 aria-hidden="true" className={className} />;
	}

	return <IconDownload aria-hidden="true" className={className} />;
};
