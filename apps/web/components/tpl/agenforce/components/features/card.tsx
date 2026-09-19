import type React from "react";
import { IllustrationBackground } from "@/components/landing/illustration-background";
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
			className={cn("w-full overflow-hidden rounded-xl bg-card/40", className)}
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
				"px-5 pt-5 pb-7 flex items-center justify-between",
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
	return <h3 className={cn("text-2xl md:text-3xl", className)}>{children}</h3>;
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
				"relative isolate h-80 sm:h-60 md:h-80 overflow-hidden perspective-distant",
				className,
			)}
		>
			<IllustrationBackground />
			{children}
		</div>
	);
};
