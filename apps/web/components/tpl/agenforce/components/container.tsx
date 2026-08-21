import type React from "react";
import { cn } from "@/components/tpl/agenforce/lib/utils";

export const Container = ({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) => {
	return (
		<div className={cn("max-w-7xl px-4 md:px-8 mx-auto", className)}>
			{children}
		</div>
	);
};
