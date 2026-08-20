import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

type SubheadingTag = "p" | "span" | "div";

interface SubheadingProps extends React.HTMLAttributes<HTMLElement> {
	tag?: SubheadingTag;
	children: React.ReactNode;
}

export function Subheading({
	tag: Tag = "p",
	children,
	className,
	...props
}: SubheadingProps) {
	return (
		<Tag
			className={cn(
				"text-sm text-neutral-600 md:text-base lg:text-lg dark:text-neutral-400",
				className,
			)}
			{...props}
		>
			{children}
		</Tag>
	);
}
