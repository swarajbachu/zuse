import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Card } from "../ui/card.tsx";
import { Frame, FrameFooter } from "../ui/frame.tsx";
import { RemoteAccessSectionHeader } from "./remote-access/section-header.tsx";

export function CloudSettingsGroup({
	title,
	description,
	action,
	footer,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
	readonly footer?: ReactNode;
	readonly children: ReactNode;
}) {
	return (
		<Frame>
			<RemoteAccessSectionHeader
				title={title}
				tooltip={description}
				action={action}
			/>
			<Card className="overflow-hidden">
				<div className="flex flex-col divide-y divide-border/40">
					{children}
				</div>
			</Card>
			{footer === undefined ? null : (
				<FrameFooter className="px-2 py-1.5">{footer}</FrameFooter>
			)}
		</Frame>
	);
}

export function CloudSettingsRow({
	title,
	description,
	action,
	children,
	className,
}: {
	readonly title: string;
	readonly description?: ReactNode;
	readonly action?: ReactNode;
	readonly children?: ReactNode;
	readonly className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-2 px-3 py-2.5", className)}>
			<div className="flex min-w-0 items-center gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium text-foreground">{title}</p>
					{description === undefined ? null : (
						<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{action === undefined ? null : (
					<div className="flex shrink-0 items-center gap-1.5">{action}</div>
				)}
			</div>
			{children}
		</div>
	);
}
