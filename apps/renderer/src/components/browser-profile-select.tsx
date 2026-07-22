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
				aria-label="Browser profile"
			>
				<SelectValue>
					{selected === undefined
						? "No supported profile found"
						: `${selected.source} · ${selected.profile}`}
				</SelectValue>
			</SelectTrigger>
			<SelectPopup>
				{profiles.map((profile) => (
					<SelectItem key={profile.id} value={profile.id}>
						<span className="truncate">
							{profile.source} · {profile.profile}
							{profile.isDefault ? " (Default)" : ""}
						</span>
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}
