export function StepHeader({
	title,
	subtitle,
}: {
	// `kicker` was removed — the StepIndicator dots already communicate position,
	// and the extra uppercase line just pushed the meaningful content down.
	title: string;
	subtitle: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<h2 className="text-xl font-semibold tracking-tight text-foreground">
				{title}
			</h2>
			<p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
				{subtitle}
			</p>
		</div>
	);
}
