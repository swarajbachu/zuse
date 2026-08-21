import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
	as?: HeadingTag;
	children: React.ReactNode;
}

export function Heading({
	as: Tag = "h1",
	children,
	className,
	...props
}: HeadingProps) {
	return (
		<Tag
			className={cn(
				"text-2xl tracking-tight text-balance text-neutral-700 md:text-4xl lg:text-5xl dark:text-neutral-300",
				className,
			)}
			{...props}
		>
			{children}
		</Tag>
	);
}
