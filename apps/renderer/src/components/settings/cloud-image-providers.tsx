import "@zuse/i18n/english/settings";
import type { CloudAccountImage, CloudProviderOption } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import boatLogo from "../../assets/cloud-providers/boat.svg";
import boxdLogo from "../../assets/cloud-providers/boxd.svg";
import e2bLogo from "../../assets/cloud-providers/e2b.png";
import {
	cloudProviderLabel,
	orderedCloudProviders,
} from "../../lib/cloud-provider-presentation.ts";
import { Badge } from "../ui/badge.tsx";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { CloudImageBuildHistory } from "./cloud-image-build-history.tsx";

// Bundled provider marks from boxd.sh/favicon.svg, boat.dev/icon.svg, and e2b.dev/icon1.png.
const logos: Readonly<Record<string, string>> = {
	boxd: boxdLogo,
	box: boatLogo,
	e2b: e2bLogo,
};

export function CloudImageProviders({
	providers,
	images,
	selectedProvider,
	onSelectProvider,
	disabled = false,
}: {
	readonly providers: readonly CloudProviderOption[];
	readonly images: readonly CloudAccountImage[];
	readonly selectedProvider?: string | null;
	readonly onSelectProvider?: (providerId: string) => void;
	readonly disabled?: boolean;
}) {
	const { message } = useMessages(["settings"]);
	const [selected, setSelected] = useState<string | null>(null);
	const groupName = useId();
	const selectedImage = images.find((image) => image.providerId === selected);
	const status = (image: CloudAccountImage | undefined) => (
		<Badge
			variant={
				image?.state === "ready"
					? "success"
					: image?.state === "failed" || image?.state === "auth-broken"
						? "error"
						: "warning"
			}
		>
			{message(`settings:cloud_images_state_${image?.state ?? "checking"}`)}
		</Badge>
	);
	const providerName = (providerId: string) => (
		<>
			{logos[providerId] ? (
				<img
					src={logos[providerId]}
					alt=""
					className={`size-4 shrink-0 ${providerId === "boxd" ? "invert dark:invert-0" : providerId === "box" ? "dark:invert" : ""}`}
				/>
			) : null}
			<span className="font-medium">{cloudProviderLabel(providerId)}</span>
			{providerId === "boxd" ? (
				<Badge variant="outline">
					{message("settings:cloud_images_recommended")}
				</Badge>
			) : null}
		</>
	);
	return (
		<>
			<div className="space-y-1 px-3 py-2">
				{orderedCloudProviders(providers).map((provider) => {
					const image = images.find(
						(image) => image.providerId === provider.providerId,
					);
					return (
						<div key={provider.providerId} className="flex items-center gap-1">
							{onSelectProvider ? (
								<label className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-muted/50">
									<input
										type="radio"
										name={groupName}
										value={provider.providerId}
										checked={selectedProvider === provider.providerId}
										disabled={disabled}
										onChange={() => onSelectProvider(provider.providerId)}
										className="accent-primary"
									/>
									{providerName(provider.providerId)}
									{provider.billingSource ? (
										<span className="text-[11px] text-muted-foreground">
											{message(
												provider.billingSource === "provider"
													? "settings:cloud_hosting_provider_billed"
													: "settings:cloud_hosting_zuse_billed",
											)}
										</span>
									) : null}
								</label>
							) : null}
							<button
								type="button"
								className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={message("settings:cloud_images_view_logs", {
									provider: cloudProviderLabel(provider.providerId),
								})}
								aria-haspopup="dialog"
								onClick={() => setSelected(provider.providerId)}
							>
								{!onSelectProvider ? providerName(provider.providerId) : null}
								{image ? (
									<span className="text-[11px] text-muted-foreground">
										{message(
											image?.source === "custom-snapshot"
												? "settings:cloud_hosting_own_snapshot"
												: "settings:cloud_hosting_zuse_image",
										)}
									</span>
								) : null}
								{status(image)}
								<span className="text-[11px] text-muted-foreground">
									{message("settings:diagnostics_pane_open_logs")}
								</span>
								<ChevronRight
									className="size-3.5 text-muted-foreground"
									aria-hidden
								/>
							</button>
						</div>
					);
				})}
			</div>
			<Dialog
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
			>
				<DialogPopup className="max-w-xl">
					<DialogHeader>
						<DialogTitle>
							{selected === null
								? ""
								: message("settings:cloud_images_view_logs", {
										provider: cloudProviderLabel(selected),
									})}
						</DialogTitle>
						<DialogDescription className="sr-only">
							{message("settings:cloud_images_details_description")}
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="px-1 pb-2">
						{selectedImage !== undefined && selectedImage.builds.length > 0 ? (
							<CloudImageBuildHistory
								key={selected}
								builds={selectedImage.builds}
								expandLatest
							/>
						) : (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								{message("settings:cloud_images_no_builds")}
							</p>
						)}
					</DialogPanel>
				</DialogPopup>
			</Dialog>
		</>
	);
}
