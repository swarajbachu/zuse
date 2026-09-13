import { cn } from "~/lib/utils";

export function CompactEmptyState({
	title,
	description,
	className,
}: {
	readonly title: string;
	readonly description?: string;
	readonly className?: string;
}) {
	return (
		<div className={cn("px-3 py-3 text-center", className)}>
			<p className="text-[11px] font-medium text-foreground/85">{title}</p>
			{description === undefined ? null : (
				<p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
					{description}
				</p>
			)}
		</div>
	);
}
