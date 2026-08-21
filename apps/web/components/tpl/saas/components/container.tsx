import type React from "react";
import { cn } from "@/components/tpl/saas/lib/utils";

type ContainerProps = React.HTMLAttributes<HTMLElement> & {
	as?: "div" | "section";
	children: React.ReactNode;
};

export function Container({
	as,
	children,
	className,
	...props
}: ContainerProps) {
	const styles = cn("mx-auto max-w-7xl px-4 md:px-8", className);
	if (as === "section") {
		return (
			<section className={styles} {...props}>
				{children}
			</section>
		);
	}
	return (
		<div className={styles} {...props}>
			{children}
		</div>
	);
}
