import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Card } from "./card.tsx";
import { Frame, FrameFooter, FrameHeader } from "./frame.tsx";

type SettingsHeaderProps = {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
};

function SettingsHeader({ title, description, action }: SettingsHeaderProps) {
	return (
		<FrameHeader className="flex w-full flex-row items-start justify-between gap-3 px-2.5 py-2">
			<div className="min-w-0">
				<p className="truncate text-xs font-medium leading-4 text-foreground">
					{title}
				</p>
				{description === undefined ? null : (
					<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
						{description}
					</div>
				)}
			</div>
			{action === undefined ? null : (
				<div className="flex h-7 shrink-0 items-center">{action}</div>
			)}
		</FrameHeader>
	);
}

export function SettingsFrame({
	title,
	action,
	description,
	bodyClassName,
	flush,
	children,
}: SettingsHeaderProps & {
	bodyClassName?: string;
	flush?: boolean;
	children?: ReactNode;
}) {
	return (
		<Frame>
			<SettingsHeader title={title} action={action} />
			{children === undefined ? null : (
				<Card className={bodyClassName}>
					{flush ? children : <div className="px-3 py-2.5">{children}</div>}
				</Card>
			)}
			{description === undefined ? null : (
				<FrameFooter className="px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
					{description}
				</FrameFooter>
			)}
		</Frame>
	);
}

export function SettingsGroup({
	title,
	description,
	action,
	trailing,
	footer,
	children,
}: SettingsHeaderProps & {
	trailing?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Frame>
			<SettingsHeader
				title={title}
				description={description}
				action={action ?? trailing}
			/>
			<Card className="overflow-hidden">
				<div className="flex flex-col divide-y divide-border">{children}</div>
			</Card>
			{footer === undefined ? null : (
				<FrameFooter className="px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
					{footer}
				</FrameFooter>
			)}
		</Frame>
	);
}

export function SettingsCard({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function SettingsCardHeader({
	icon: Icon,
	title,
	action,
}: {
	icon?: IconSvgElement;
	title: string;
	action?: ReactNode;
}) {
	return (
		<header className="flex h-8 shrink-0 items-center gap-2 bg-muted/60 px-3 text-muted-foreground">
			{Icon === undefined ? null : (
				<HugeiconsIcon icon={Icon} className="size-3.5" aria-hidden />
			)}
			<span className="min-w-0 flex-1 truncate text-[11px] font-medium">
				{title}
			</span>
			{action === undefined ? null : (
				<div className="flex shrink-0 items-center gap-2">{action}</div>
			)}
		</header>
	);
}

export function SettingsRow({
	icon: Icon,
	title,
	description,
	action,
	children,
	className,
}: {
	icon?: IconSvgElement;
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col gap-2 px-3 py-2.5", className)}>
			<div className="flex min-w-0 items-start gap-2.5">
				{Icon === undefined ? null : (
					<HugeiconsIcon
						icon={Icon}
						className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
				)}
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium leading-4 text-foreground">
						{title}
					</p>
					{description === undefined ? null : (
						<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{action === undefined ? null : (
					<div className="flex h-7 shrink-0 items-center gap-1.5">{action}</div>
				)}
			</div>
			{children}
		</div>
	);
}
