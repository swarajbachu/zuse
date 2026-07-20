import { Alert02Icon } from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";

export function DirectoryUnavailableBanner({ archived = false }) {
	return (
		<div
			role="status"
			className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 text-destructive text-xs"
		>
			<HugeiconsIcon icon={Alert02Icon} className="size-4 shrink-0" />
			<span>
				{archived
					? "This directory is unavailable."
					: "This directory has been deleted and it's inaccessible."}
			</span>
		</div>
	);
}
