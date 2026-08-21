import type React from "react";
import { cn } from "@/components/tpl/nodus/lib/utils";

export const SubHeading = ({
	children,
	className,
	as: Component = "h2",
}: {
	children: React.ReactNode;
	className?: string;
	as?: "h2" | "p";
}) => {
	const styles = cn(
		"text-center text-sm font-medium tracking-tight text-gray-600 md:text-sm lg:text-base dark:text-gray-300",
		className,
	);
	if (Component === "p") return <p className={styles}>{children}</p>;
	return <h2 className={styles}>{children}</h2>;
};
