import "@zuse/i18n/english/projects";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import type { BrowserCookieImportStatus } from "../lib/bridge.ts";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "./ui/select.tsx";

export function BrowserProfileSelect({
	profiles,
	value,
	onValueChange,
	className,
}: {
	profiles: BrowserCookieImportStatus["availableProfiles"];
	value: string | undefined;
	onValueChange: (value: string | undefined) => void;
	className?: string;
}) {
	const { message: uiMessage } = useUiMessages(["projects"]);

	const selected =
		profiles.find((profile) => profile.id === value) ?? profiles[0];
	return (
		<Select
			value={value}
			onValueChange={(next) =>
				onValueChange(typeof next === "string" ? next : undefined)
			}
		>
			<SelectTrigger
				size="sm"
				className={className}
				aria-label={uiMessage(
					"projects:browser_profile_select_browser_profile",
				)}
			>
				<SelectValue>
					{selected === undefined
						? uiMessage(
								"projects:browser_profile_select_no_supported_profile_found",
							)
						: `${selected.source} · ${selected.profile}`}
				</SelectValue>
			</SelectTrigger>
			<SelectPopup>
				{profiles.map((profile) => (
					<SelectItem key={profile.id} value={profile.id}>
						<span className="truncate">
							{profile.source} · {profile.profile}
							{profile.isDefault
								? uiMessage("projects:browser_profile_select_default")
								: ""}
						</span>
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}
