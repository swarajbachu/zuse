import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Alert02Icon } from "@zuse/icons/bulk-rounded";

export function DirectoryUnavailableBanner({ archived = false }) {
	const { message: uiMessage } = useUiMessages(["chat"]);

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
					? uiMessage(
							"chat:directory_unavailable_banner_this_directory_is_unavailable",
						)
					: uiMessage(
							"chat:directory_unavailable_banner_this_directory_has_been_deleted_and_it_s_inaccessible",
						)}
			</span>
		</div>
	);
}
