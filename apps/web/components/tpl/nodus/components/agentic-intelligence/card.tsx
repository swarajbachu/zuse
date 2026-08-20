import type React from "react";
import { cn } from "@/components/tpl/nodus/lib/utils";

export const Card = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => {
	return <div className={cn("p-4 md:p-8", className)}>{children}</div>;
};

export const CardTitle = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => {
	return (
		<h3 className={cn("text-heading text-lg font-medium", className)}>
			{children}
		</h3>
	);
};

export const CardDescription = ({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) => {
	return (
		<p className={cn("text-muted-foreground mt-2 text-base", className)}>
			{children}
		</p>
	);
};
