import type { ReactNode, Ref } from "react";
import { cn } from "~/lib/utils";
import { LogoTraceLoader } from "./logo-trace-loader.tsx";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "./ui/frame.tsx";

/**
 * Full-window surface for everything shown before the app itself can render:
 * startup, hosted sign-in, browser pairing, and their failures. The Zuse mark
 * stays mounted across states, so finishing a load closes the trace and fills
 * the logo instead of swapping one screen for another.
 */
export function AccessScreen({
	loading,
	loaderComplete = false,
	loaderLabel,
	title,
	description,
	headingRef,
	headingId,
	footer,
	children,
	className,
	onLoaderDone,
}: {
	readonly loading: boolean;
	/** Keeps the loading layout while the mark plays its closing trace. */
	readonly loaderComplete?: boolean;
	readonly loaderLabel: string;
	readonly title?: ReactNode;
	readonly description?: ReactNode;
	readonly headingRef?: Ref<HTMLHeadingElement>;
	readonly headingId?: string;
	readonly footer?: ReactNode;
	readonly children?: ReactNode;
	readonly className?: string;
	readonly onLoaderDone?: () => void;
}) {
	return (
		<div
			className={cn(
				"flex min-h-dvh w-full items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground",
				className,
			)}
		>
			<main
				aria-busy={loading && !loaderComplete}
				aria-labelledby={headingId}
				aria-live="polite"
				className="flex w-full max-w-sm flex-col items-center"
			>
				<LogoTraceLoader
					ariaLabel={loaderLabel}
					className={cn(
						"text-foreground transition-[width,height] duration-300 ease-out motion-reduce:transition-none",
						loading ? "size-20" : "size-14",
					)}
					loading={loading && !loaderComplete}
					onDone={onLoaderDone}
				/>
				{loading ? (
					<div className="mt-2 flex flex-col items-center gap-1 text-center">
						{title === undefined ? null : (
							<h1
								className="font-medium text-sm outline-none"
								id={headingId}
								ref={headingRef}
								tabIndex={-1}
							>
								{title}
							</h1>
						)}
						{description === undefined ? null : (
							<p className="text-muted-foreground text-xs leading-5">
								{description}
							</p>
						)}
						{children === undefined ? null : (
							<div className="mt-3 flex w-60 flex-col gap-2">{children}</div>
						)}
					</div>
				) : (
					<Frame className="mt-4 w-full shadow-overlay-sm">
						<FrameHeader className="gap-0.5 px-3 py-2.5">
							<h1
								className="font-semibold text-sm outline-none"
								id={headingId}
								ref={headingRef}
								tabIndex={-1}
							>
								{title}
							</h1>
							{description === undefined ? null : (
								<div className="text-muted-foreground text-xs leading-5">
									{description}
								</div>
							)}
						</FrameHeader>
						{children === undefined ? null : (
							<FramePanel className="flex flex-col gap-2 p-3">
								{children}
							</FramePanel>
						)}
						{footer === undefined ? null : (
							<FrameFooter className="px-3 py-2 text-[11px] text-muted-foreground leading-4">
								{footer}
							</FrameFooter>
						)}
					</Frame>
				)}
			</main>
		</div>
	);
}
