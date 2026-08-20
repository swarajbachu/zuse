import type React from "react";
import { cn } from "@/components/tpl/nodus/lib/utils";

export const Container = ({
	children,
	className,
	as,
}: {
	children: React.ReactNode;
	className?: string;
	as?: "div" | "nav";
}) => {
	const styles = cn("max-w-7xl mx-auto", className);
	if (as === "nav") return <nav className={styles}>{children}</nav>;
	return <div className={styles}>{children}</div>;
};
