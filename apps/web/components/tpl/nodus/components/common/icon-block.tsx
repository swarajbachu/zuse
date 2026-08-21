import { cn } from "@/components/tpl/nodus/lib/utils";

export const IconBlock = ({
	icon,
	className,
	children,
}: {
	icon: React.ReactNode;
	className?: string;
	children?: React.ReactNode;
}) => {
	return (
		<div
			className={cn(
				"relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-white shadow-md dark:border-neutral-600 dark:bg-neutral-900",
				className,
			)}
		>
			{icon}
			{children}
		</div>
	);
};
