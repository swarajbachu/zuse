import type React from "react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

export const Card = ({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) => {
	return (
		<div
			className={cn(
				"max-w-l mx-auto bg-neutral-50 dark:bg-neutral-800 rounded-lg",
				className,
			)}
		>
			{children}
		</div>
	);
};

export const CardContent = ({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) => {
	return (
		<div
			className={cn(
				"px-4 md:px-8 md:pb-12 pb-6 flex items-center justify-between",
				className,
			)}
		>
			{children}
		</div>
	);
};

export const CardCTA = ({
	className,
	children,
	...rest
}: React.ComponentProps<"button">) => {
	return (
		<button
			className={cn(
				"size-5 md:size-10 shrink-0 rounded-full border border-neutral-200 dark:border-neutral-800 flex items-center justify-center active:scale-[0.98] transition duration-200",
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
};

export const CardTitle = ({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) => {
	return (
		<h3 className={cn("text-lg md:text-2xl font-bold font-display", className)}>
			{children}
		</h3>
	);
};

export const CardSkeleton = ({
	className,
	children,
}: {
	className?: string;
	children?: React.ReactNode;
}) => {
	return (
		<div
			className={cn(
				"relative h-80 sm:h-60 md:h-80 overflow-hidden perspective-distant",
				className,
			)}
		>
			{children}
		</div>
	);
};
