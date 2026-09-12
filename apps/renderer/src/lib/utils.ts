import { formatNumber } from "@zuse/i18n";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function formatCompactNumber(n: number): string {
	return formatNumber(n, { notation: "compact", maximumFractionDigits: 1 });
}
