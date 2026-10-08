import type { ReactNode, Ref } from "react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "./ui/frame.tsx";

/** Load the sign-in/error panel only after the initial loading surface finishes. */
export default function AccessScreenDetails({
	title,
	description,
	footer,
	headingId,
	headingRef,
	children,
}: {
	readonly title?: ReactNode;
	readonly description?: ReactNode;
	readonly footer?: ReactNode;
	readonly headingId?: string;
	readonly headingRef?: Ref<HTMLHeadingElement>;
	readonly children?: ReactNode;
}) {
	return (
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
				<FramePanel className="flex flex-col gap-2 p-3">{children}</FramePanel>
			)}
			{footer === undefined ? null : (
				<FrameFooter className="px-3 py-2 text-[11px] text-muted-foreground leading-4">
					{footer}
				</FrameFooter>
			)}
		</Frame>
	);
}
