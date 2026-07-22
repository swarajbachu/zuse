import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons-pro/core-bulk-rounded";

export function DirectoryUnavailableBanner({ archived = false }) {
	return (
		<div
			role="status"
			className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-alert-error-bg px-3 py-2 text-foreground text-xs"
		>
			<HugeiconsIcon
				icon={Alert02Icon}
				aria-hidden="true"
				className="size-4 shrink-0 text-destructive"
			/>
			<span>
				{archived
					? "This directory is unavailable."
					: "This directory has been deleted and it's inaccessible."}
			</span>
		</div>
	);
}
